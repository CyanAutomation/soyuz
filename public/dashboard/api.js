export async function fetchJson(path, init = {}, fetcher = fetch) {
  const response = await fetcher(path, init);
  if (!response.ok) {
    const error = new Error("request failed");
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  return body.data ?? body;
}
