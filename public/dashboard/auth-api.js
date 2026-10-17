export async function revokeAccessToken(accessToken, clientId, fetcher = fetch) {
  const response = await fetcher("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: accessToken,
      token_type_hint: "access_token",
      client_id: clientId,
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("OAuth token revocation failed");
}
