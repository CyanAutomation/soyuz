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

export interface FieldOptions {
  id: string;
  label: string;
  control: HTMLElement;
  helpText?: string;
  errorText?: string;
  className?: string;
}

export interface FieldParts {
  element: HTMLDivElement;
  label: HTMLLabelElement;
  control: HTMLElement;
  help: HTMLParagraphElement | null;
  error: HTMLParagraphElement | null;
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

/** Build a labelled field and associate its help and validation messages with the control. */
export function createField(
  options: FieldOptions,
  ownerDocument: Document = document,
): FieldParts {
  const element = ownerDocument.createElement("div");
  element.className = ["field", options.className].filter(Boolean).join(" ");

  const label = ownerDocument.createElement("label");
  label.className = "field__label";
  label.htmlFor = options.id;
  label.textContent = options.label;
  options.control.id = options.id;

  const describedBy = new Set((options.control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
  let help: HTMLParagraphElement | null = null;
  if (options.helpText) {
    help = ownerDocument.createElement("p");
    help.className = "field__help";
    help.id = `${options.id}-help`;
    help.textContent = options.helpText;
    describedBy.add(help.id);
  }

  let error: HTMLParagraphElement | null = null;
  if (options.errorText) {
    error = ownerDocument.createElement("p");
    error.className = "field__error";
    error.id = `${options.id}-error`;
    error.textContent = options.errorText;
    describedBy.add(error.id);
    options.control.setAttribute("aria-invalid", "true");
  } else {
    options.control.removeAttribute("aria-invalid");
  }

  if (describedBy.size > 0) options.control.setAttribute("aria-describedby", [...describedBy].join(" "));
  else options.control.removeAttribute("aria-describedby");

  element.append(label, options.control);
  if (help) element.append(help);
  if (error) element.append(error);
  return { element, label, control: options.control, help, error };
}

/** Render a human-readable timestamp with semantic machine-readable time. */
export function createTimestamp(
  label: string,
  value: string | null,
  className = "",
  ownerDocument: Document = document,
): HTMLParagraphElement {
  const element = ownerDocument.createElement("p");
  element.className = ["ui-timestamp", className].filter(Boolean).join(" ");
  const labelElement = ownerDocument.createElement("span");
  labelElement.className = "ui-timestamp__label";
  labelElement.textContent = `${label} · `;
  const time = ownerDocument.createElement("time");
  const timestamp = value ? new Date(value) : null;
  if (value && timestamp && !Number.isNaN(timestamp.getTime())) {
    time.dateTime = value;
    time.textContent = timestamp.toLocaleString();
  } else {
    time.textContent = "Time unavailable";
  }
  element.append(labelElement, time);
  return element;
}
