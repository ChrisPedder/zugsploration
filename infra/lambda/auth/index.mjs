import pkg from "jose/dist/node/cjs/index.js";
const { jwtVerify, createLocalJWKSet } = pkg;
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

let configCache = null;

async function getConfig() {
  if (configCache) return configCache;
  const ssm = new SSMClient({ region: "eu-central-1" });
  const result = await ssm.send(
    new GetParameterCommand({ Name: "/zugsploration/auth-config" })
  );
  configCache = JSON.parse(result.Parameter.Value);
  return configCache;
}

function parseCookies(headers) {
  const cookies = {};
  if (!headers.cookie) return cookies;
  for (const entry of headers.cookie) {
    for (const pair of entry.value.split(";")) {
      const [k, ...v] = pair.trim().split("=");
      cookies[k.trim()] = v.join("=");
    }
  }
  return cookies;
}

function redirectToLogin(config, distributionDomain) {
  const callbackUrl = `https://${distributionDomain}/_callback`;
  const loginUrl =
    `${config.cognitoDomain}/login?client_id=${config.clientId}` +
    `&response_type=code&scope=openid+email&redirect_uri=${encodeURIComponent(callbackUrl)}`;
  return {
    status: "302",
    statusDescription: "Found",
    headers: { location: [{ key: "Location", value: loginUrl }] },
  };
}

function setCookieHeaders(tokens, distributionDomain) {
  const maxAge = 3600;
  const refreshMaxAge = 30 * 24 * 3600;
  const base = `; Path=/; Domain=${distributionDomain}; HttpOnly; Secure; SameSite=Lax`;
  return {
    "set-cookie": [
      { key: "Set-Cookie", value: `id_token=${tokens.id_token}; Max-Age=${maxAge}${base}` },
      { key: "Set-Cookie", value: `access_token=${tokens.access_token}; Max-Age=${maxAge}${base}` },
      { key: "Set-Cookie", value: `refresh_token=${tokens.refresh_token}; Max-Age=${refreshMaxAge}${base}` },
    ],
  };
}

function clearCookieHeaders(distributionDomain) {
  const base = `; Path=/; Domain=${distributionDomain}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  return {
    "set-cookie": [
      { key: "Set-Cookie", value: `id_token=deleted${base}` },
      { key: "Set-Cookie", value: `access_token=deleted${base}` },
      { key: "Set-Cookie", value: `refresh_token=deleted${base}` },
    ],
  };
}

async function exchangeCode(config, code, distributionDomain) {
  const callbackUrl = `https://${distributionDomain}/_callback`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    redirect_uri: callbackUrl,
    code,
  });

  const resp = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status}`);
  return resp.json();
}

async function refreshTokens(config, refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  });

  const resp = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  return resp.json();
}

let jwksCache = null;

async function verifyToken(config, idToken) {
  if (!jwksCache) {
    const jwksUrl = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}/.well-known/jwks.json`;
    const resp = await fetch(jwksUrl);
    jwksCache = await resp.json();
  }

  const { payload } = await jwtVerify(
    idToken,
    createLocalJWKSet(jwksCache),
    {
      issuer: `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`,
      audience: config.clientId,
    }
  );
  return payload;
}

export async function handler(event) {
  const config = await getConfig();
  const request = event.Records[0].cf.request;
  const distributionDomain = event.Records[0].cf.config.distributionDomainName;
  const uri = request.uri;
  const headers = request.headers;

  if (uri === "/_callback") {
    const qs = new URLSearchParams(request.querystring);
    const code = qs.get("code");
    if (!code) return redirectToLogin(config, distributionDomain);

    try {
      const tokens = await exchangeCode(config, code, distributionDomain);
      return {
        status: "302",
        statusDescription: "Found",
        headers: {
          location: [{ key: "Location", value: `https://${distributionDomain}/` }],
          ...setCookieHeaders(tokens, distributionDomain),
        },
      };
    } catch {
      return redirectToLogin(config, distributionDomain);
    }
  }

  if (uri === "/_logout") {
    const logoutUrl =
      `${config.cognitoDomain}/logout?client_id=${config.clientId}` +
      `&logout_uri=${encodeURIComponent(`https://${distributionDomain}/`)}`;
    return {
      status: "302",
      statusDescription: "Found",
      headers: {
        location: [{ key: "Location", value: logoutUrl }],
        ...clearCookieHeaders(distributionDomain),
      },
    };
  }

  const cookies = parseCookies(headers);
  const requestUrl = `https://${distributionDomain}${uri}${request.querystring ? "?" + request.querystring : ""}`;

  if (!cookies.id_token) {
    if (cookies.refresh_token) {
      try {
        const tokens = await refreshTokens(config, cookies.refresh_token);
        return {
          status: "302",
          statusDescription: "Found",
          headers: {
            location: [{ key: "Location", value: requestUrl }],
            ...setCookieHeaders({ ...tokens, refresh_token: cookies.refresh_token }, distributionDomain),
          },
        };
      } catch {
        return redirectToLogin(config, distributionDomain);
      }
    }
    return redirectToLogin(config, distributionDomain);
  }

  try {
    await verifyToken(config, cookies.id_token);
    return request;
  } catch {
    if (cookies.refresh_token) {
      try {
        const tokens = await refreshTokens(config, cookies.refresh_token);
        return {
          status: "302",
          statusDescription: "Found",
          headers: {
            location: [{ key: "Location", value: requestUrl }],
            ...setCookieHeaders({ ...tokens, refresh_token: cookies.refresh_token }, distributionDomain),
          },
        };
      } catch {
        return redirectToLogin(config, distributionDomain);
      }
    }
    return redirectToLogin(config, distributionDomain);
  }
}
