export type NoticeTone = "info" | "empty" | "success" | "warning" | "danger";
export type BadgeTone = "active" | "warning" | "success" | "danger" | "neutral";

interface NoticeElement {
  hidden: HTMLElement["hidden"];
  textContent: string | null;
  className: string;
}

interface BusyButtonElement {
  disabled: boolean;
  textContent: string | null;
  dataset: DOMStringMap;
  classList: Pick<DOMTokenList, "toggle">;
}

/** A small, reusable status component for visible and screen-reader feedback. */
export function setNotice(element: NoticeElement, message: string, tone: NoticeTone): void {
  element.hidden = message.length === 0;
  element.textContent = message;
  element.className = `notice notice--${tone}`;
}

/** Pair a disabled busy state with a meaningful label; the nearby live notice announces progress. */
export function setButtonBusy(button: BusyButtonElement, busy: boolean, busyLabel?: string): void {
  const idleLabel = button.dataset.idleLabel ?? button.textContent ?? "";
  button.dataset.idleLabel = idleLabel;
  button.disabled = busy;
  button.classList.toggle("button--busy", busy);
  button.textContent = busy && busyLabel ? busyLabel : idleLabel;
}

/** Create a text-safe status badge that can be shared by dashboard views. */
export function createBadge(label: string, tone: BadgeTone, ownerDocument: Document = document): HTMLSpanElement {
  const badge = ownerDocument.createElement("span");
  badge.className = `badge badge--${tone}`;
  badge.textContent = label;
  return badge;
}
