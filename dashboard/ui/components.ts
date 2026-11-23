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

export interface MetricItem {
  label: string;
  value: string;
  detail?: string;
}

export interface ActionButtonOptions {
  variant?: "primary" | "secondary";
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ownerDocument?: Document;
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

/** Create a labelled native action button with text-only content and a typed callback. */
export function createActionButton(
  label: string,
  onClick: () => void,
  options: ActionButtonOptions = {},
): HTMLButtonElement {
  const ownerDocument = options.ownerDocument ?? document;
  const button = ownerDocument.createElement("button");
  button.className = ["button", `button--${options.variant ?? "secondary"}`, options.className].filter(Boolean).join(" ");
  button.type = "button";
  button.textContent = label;
  button.disabled = options.disabled ?? false;
  if (options.ariaLabel) button.setAttribute("aria-label", options.ariaLabel);
  button.addEventListener("click", () => {
    if (!button.disabled) onClick();
  });
  return button;
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

  element.appendChild(header);
  element.appendChild(body);
  element.appendChild(footer);
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
    item.appendChild(term);
    item.appendChild(description);
    list.appendChild(item);
  }
  return list;
}

/** Reusable semantic metric tiles for compact dashboard summaries. */
export function createMetricGrid(
  metrics: readonly MetricItem[],
  className = "",
  ownerDocument: Document = document,
): HTMLElement {
  const grid = ownerDocument.createElement("div");
  grid.className = ["ui-metric-grid", className].filter(Boolean).join(" ");
  for (const metric of metrics) {
    const item = ownerDocument.createElement("article");
    item.className = "ui-metric";
    const label = ownerDocument.createElement("span");
    label.className = "ui-metric__label";
    label.textContent = metric.label;
    const value = ownerDocument.createElement("strong");
    value.className = "ui-metric__value";
    value.textContent = metric.value;
    item.appendChild(label);
    item.appendChild(value);
    if (metric.detail) {
      const detail = ownerDocument.createElement("p");
      detail.className = "ui-metric__detail";
      detail.textContent = metric.detail;
      item.appendChild(detail);
    }
    grid.appendChild(item);
  }
  return grid;
}

/** Reusable titled list for short, text-only summaries. */
export function createSummaryList(
  titleText: string,
  items: readonly string[],
  ownerDocument: Document = document,
  className = "",
): HTMLElement {
  const section = ownerDocument.createElement("section");
  section.className = ["ui-summary-list", className].filter(Boolean).join(" ");
  const heading = ownerDocument.createElement("h3");
  heading.textContent = titleText;
  const list = ownerDocument.createElement("ul");
  for (const text of items) {
    const item = ownerDocument.createElement("li");
    item.textContent = text;
    list.appendChild(item);
  }
  section.appendChild(heading);
  section.appendChild(list);
  return section;
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

  element.appendChild(label);
  element.appendChild(options.control);
  if (help) element.appendChild(help);
  if (error) element.appendChild(error);
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
  element.appendChild(labelElement);
  element.appendChild(time);
  return element;
}
