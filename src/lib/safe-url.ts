/** Removes credentials and request-specific data before showing a persisted URL. */
export function safeUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "about:invalid";
  }
}
