export type NoticeTone = "info" | "empty" | "success" | "warning" | "danger";
export type BadgeTone = "active" | "warning" | "success" | "danger" | "neutral";

export interface CardOptions {
  className?: string;
  tagName?: "article" | "section" | "div";
}

export interface CardParts {
  element: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
}

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

/** Create a reusable content card with stable semantic slots for its sections. */
export function createCard(options: CardOptions = {}, ownerDocument: Document = document): CardParts {
  const element = ownerDocument.createElement(options.tagName ?? "article");
  element.className = ["card", "card--structured", options.className].filter(Boolean).join(" ");

  const header = ownerDocument.createElement("header");
  header.className = "card__header";
  const body = ownerDocument.createElement("div");
  body.className = "card__body";
  const footer = ownerDocument.createElement("footer");
  footer.className = "card__footer";

  element.append(header, body, footer);
  return { element, header, body, footer };
}

/** Create a text-safe definition list for labelled facts. */
export function createDefinitionList(
  entries: Array<[string, string]>,
  className = "data-list",
  ownerDocument: Document = document,
): HTMLDListElement {
  const list = ownerDocument.createElement("dl");
  list.className = className;
  for (const [label, value] of entries) {
    const item = ownerDocument.createElement("div");
    item.className = "data-list__item";
    const term = ownerDocument.createElement("dt");
    term.textContent = label;
    const description = ownerDocument.createElement("dd");
    description.textContent = value;
    item.append(term, description);
    list.append(item);
  }
  return list;
}
