export type SnackBarTone = "info" | "success" | "warning" | "danger";

export interface SnackBarElement {
  hidden: boolean | "until-found";
  textContent: string | null;
  className: string;
}

export function createSnackBarController(element: SnackBarElement, durationMs = 5000) {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
    element.hidden = true;
    element.textContent = "";
    element.className = "snackbar";
  }

  function show(message: string, tone: SnackBarTone = "info"): void {
    if (timeout !== null) clearTimeout(timeout);
    element.textContent = message;
    element.className = `snackbar snackbar--${tone}`;
    element.hidden = false;
    timeout = setTimeout(clear, durationMs);
  }

  return { show, clear };
}
