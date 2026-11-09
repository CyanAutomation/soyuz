import { getOAuthApi } from "@cloudflare/workers-oauth-provider";

const origin = "https://soyuz.test";
const redirectUri = "https://client.example.test/callback";
const verifier = "soyuz-cross-worker-test-verifier-which-is-at-least-43-characters-long";
const options = {
  defaultHandler: { fetch: async () => new Response(null, { status: 404 }) },
  apiHandlers: {},
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  cookiePrefix: "__Host-oauth-",
  scopesSupported: ["soyuz:read", "offline_access"],
  requiredScopes: ["soyuz:read"],
  resourceMetadata: {
    resource: `${origin}/`,
    authorization_servers: [origin],
    resource_name: "Soyuz",
  },
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 30 * 24 * 60 * 60,
};

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/mint") return new Response(null, { status: 404 });

    const oauth = getOAuthApi(options, env);
    const client = await oauth.createClient({
      clientName: "Soyuz cross-worker integration test",
      redirectUris: [redirectUri],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const authorization = new URL(`${origin}/oauth/authorize`);
    authorization.searchParams.set("client_id", client.clientId);
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "soyuz:read");
    authorization.searchParams.set("resource", `${origin}/`);
    authorization.searchParams.set("state", crypto.randomUUID());
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    const parsed = await oauth.parseAuthRequest(new Request(authorization));
    const approved = await oauth.completeAuthorization({
      request: parsed,
      userId: "github-68898852",
      metadata: { githubLogin: "cross-worker-test" },
      props: { githubUserId: "68898852", githubLogin: "cross-worker-test" },
      scope: ["soyuz:read"],
    });
    const code = new URL(approved.redirectTo).searchParams.get("code");
    if (!code) return Response.json({ error: "authorization code missing" }, { status: 500 });
    return Response.json({ clientId: client.clientId, code, redirectUri, verifier });
  },
};
