import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as path from "path";

export class ZugsplorationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cognitoDomainPrefix = new cdk.CfnParameter(this, "CognitoDomainPrefix", {
      type: "String",
      default: "zugsploration",
    });

    // --- S3 bucket for static files ---
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // --- Cognito ---
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "zugsploration",
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: "You're invited to Zugsploration",
        emailBody:
          "Hi! You've been invited to the Zug Commute Planner. " +
          "Your temporary password is {####}. " +
          "Visit the app and log in with your email ({username}) to get started.",
      },
    });

    userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix.valueAsString },
    });

    const userPoolClient = userPool.addClient("AppClient", {
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: ["https://localhost/_callback"],
        logoutUrls: ["https://localhost/"],
      },
      authFlows: { userSrp: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // --- SSM parameter for auth Lambda config ---
    // Stores Cognito details so Lambda@Edge can read them at runtime
    // (Lambda@Edge can't use environment variables)
    const authConfigParam = new ssm.StringParameter(this, "AuthConfig", {
      parameterName: "/zugsploration/auth-config",
      stringValue: cdk.Fn.sub(
        JSON.stringify({
          userPoolId: "${UserPoolId}",
          clientId: "${ClientId}",
          cognitoDomain: "https://${DomainPrefix}.auth.${Region}.amazoncognito.com",
          region: "${Region}",
        }),
        {
          UserPoolId: userPool.userPoolId,
          ClientId: userPoolClient.userPoolClientId,
          DomainPrefix: cognitoDomainPrefix.valueAsString,
          Region: this.region,
        }
      ),
    });

    // --- Flatfox proxy Lambda ---
    const flatfoxLambda = new lambda.Function(this, "FlatfoxProxy", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "lambda_function.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/flatfox")),
      timeout: cdk.Duration.seconds(300),
      memorySize: 256,
      environment: {
        SITE_BUCKET: siteBucket.bucketName,
      },
    });

    siteBucket.grantReadWrite(flatfoxLambda);
    flatfoxLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [flatfoxLambda.functionArn],
      })
    );

    // --- API Gateway ---
    const httpApi = new apigatewayv2.HttpApi(this, "FlatfoxApi", {
      apiName: "zugsploration-flatfox",
    });

    httpApi.addRoutes({
      path: "/api/flatfox",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration(
        "FlatfoxIntegration",
        flatfoxLambda
      ),
    });

    // --- Lambda@Edge for auth ---
    const authEdgeFunction = new cloudfront.experimental.EdgeFunction(
      this,
      "AuthEdge",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/auth"), {
          exclude: ["package.json", "package-lock.json"],
        }),
        timeout: cdk.Duration.seconds(5),
        memorySize: 128,
      }
    );

    authConfigParam.grantRead(authEdgeFunction);

    // --- CloudFront ---
    const apiOrigin = new origins.HttpOrigin(
      cdk.Fn.select(
        2,
        cdk.Fn.split("/", httpApi.apiEndpoint)
      )
    );

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        edgeLambdas: [
          {
            functionVersion: authEdgeFunction.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          edgeLambdas: [
            {
              functionVersion: authEdgeFunction.currentVersion,
              eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Wire up distribution ID now that it exists
    flatfoxLambda.addEnvironment("DISTRIBUTION_ID", distribution.distributionId);
    flatfoxLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        ],
      })
    );

    // --- Deploy static site ---
    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../.."), {
          exclude: [
            ".git",
            ".git/*",
            ".claude",
            ".claude/*",
            "infra",
            "infra/*",
            "scripts",
            "scripts/*",
            "node_modules",
            "node_modules/*",
            ".gitignore",
            "*.md",
          ],
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // --- Update Cognito callback URLs with CloudFront domain ---
    new cr.AwsCustomResource(this, "UpdateCognitoCallbackUrls", {
      onUpdate: {
        service: "CognitoIdentityServiceProvider",
        action: "updateUserPoolClient",
        parameters: {
          UserPoolId: userPool.userPoolId,
          ClientId: userPoolClient.userPoolClientId,
          CallbackURLs: [
            cdk.Fn.sub("https://${Domain}/_callback", {
              Domain: distribution.distributionDomainName,
            }),
          ],
          LogoutURLs: [
            cdk.Fn.sub("https://${Domain}/", {
              Domain: distribution.distributionDomainName,
            }),
          ],
          AllowedOAuthFlows: ["code"],
          AllowedOAuthScopes: ["openid", "email"],
          AllowedOAuthFlowsUserPoolClient: true,
          SupportedIdentityProviders: ["COGNITO"],
          ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
        },
        physicalResourceId: cr.PhysicalResourceId.of("cognito-callback-urls"),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["cognito-idp:UpdateUserPoolClient"],
          resources: [userPool.userPoolArn],
        }),
      ]),
    });

    // --- GitHub Actions OIDC ---
    const ghOidcProviderArn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;

    const ghDeployRole = new iam.Role(this, "GitHubActionsDeployRole", {
      roleName: "zugsploration-github-deploy",
      assumedBy: new iam.WebIdentityPrincipal(
        ghOidcProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub":
              "repo:ChrisPedder@*/zugsploration@*:*",
          },
        }
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
      ],
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, "AppUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "DeployRoleArn", {
      value: ghDeployRole.roleArn,
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, "BucketName", {
      value: siteBucket.bucketName,
    });
  }
}
