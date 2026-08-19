#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="argos-discovery"
INFRA_DIR="$(cd "$(dirname "$0")/../infra" && pwd)"

export AWS_PROFILE

echo "==> Checking AWS credentials..."
if ! aws sts get-caller-identity --profile "$AWS_PROFILE" > /dev/null 2>&1; then
  echo "SSO session expired. Run: aws sso login --profile $AWS_PROFILE"
  exit 1
fi

echo "==> Installing CDK dependencies..."
cd "$INFRA_DIR"
npm install

echo "==> Bootstrapping CDK (if needed)..."
npx cdk bootstrap

echo "==> Deploying..."
npx cdk deploy --require-approval broadening --outputs-file outputs.json

echo ""
echo "==> Deployment complete!"
if [ -f outputs.json ]; then
  echo "Outputs:"
  python3 -c "
import json
with open('outputs.json') as f:
    outputs = json.load(f)
for stack, vals in outputs.items():
    for key, val in vals.items():
        print(f'  {key}: {val}')
"
fi

echo ""
echo "To invite a user:"
USER_POOL_ID=$(python3 -c "import json; d=json.load(open('outputs.json')); print(list(d.values())[0]['UserPoolId'])")
echo "  aws cognito-idp admin-create-user \\"
echo "    --user-pool-id $USER_POOL_ID \\"
echo "    --username user@example.com \\"
echo "    --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \\"
echo "    --desired-delivery-mediums EMAIL \\"
echo "    --profile $AWS_PROFILE"
