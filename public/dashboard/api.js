export async function fetchJson(path, init = {}, fetcher = fetch) {
  const response = await fetcher(path, init);
  if (!response.ok) throw new Error("request failed");
  const body = await response.json();
  return body.data ?? body;
}
