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

/** Accepts only web URLs, then removes credentials and request-specific data for display. */
export function safeHttpUrlForDisplay(value: string): string | null {
  if (!isHttpUrl(value)) return null;
  return safeUrlForDisplay(value);
}

/** True when a value parses as an HTTP or HTTPS URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
