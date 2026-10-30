import type { ElementNode } from "@openuidev/lang-core";
import type { NativeComponentRenderer } from "../../openui/dom-renderer";
import { RUN_STATUSES } from "../../src/domain/run-state-machine";

const STATUS_OPTIONS = ["all", ...RUN_STATUSES] as const;
const SORT_OPTIONS = ["createdAt", "displayId", "status", "repoUrl", "ref", "durationMs"] as const;

export const soyuzComponentRenderers: Record<string, NativeComponentRenderer> = {
  Stack: (existing, node, props, context) => {
    const element = reuse(existing, "div", "openui-stack");
    const direction = props.direction === "horizontal" ? "horizontal" : "vertical";
    element.classList.toggle("openui-stack--horizontal", direction === "horizontal");
    element.classList.toggle("openui-stack--vertical", direction === "vertical");
    context.renderChildren(element, Array.isArray(props.children) ? props.children : [], keyFor(node));
    return element;
  },
  Heading: (existing, _node, props) => {
    const tag = props.level === "subsection" ? "h3" : "h2";
    const element = reuse(existing, tag, "openui-heading");
    element.textContent = stringValue(props.text, 160);
    return element;
  },
  Text: (existing, _node, props) => {
    const element = reuse(existing, "p", `openui-text openui-text--${enumValue(props.tone, ["normal", "muted", "warning"], "normal")}`);
    element.textContent = stringValue(props.text, 2_000);
    return element;
  },
  MetricCard: (existing, _node, props) => {
    const element = reuse(existing, "article", `card metric-card metric-card--${enumValue(props.tone, ["neutral", "success", "warning", "danger"], "neutral")}`);
    const label = ensureChild(element, "p", "metric-card__label");
    const value = ensureChild(element, "p", "metric-card__value");
    const detail = ensureChild(element, "p", "metric-card__detail");
    label.textContent = stringValue(props.label, 100);
    value.textContent = formatMetric(props.value);
    detail.textContent = stringValue(props.detail, 300);
    detail.hidden = !props.detail;
    return element;
  },
  RunTable: (existing, node, props, context) => {
    const element = reuse(existing, "section", "card analysis-run-table");
    const title = stringValue(props.title, 120);
    let heading = element.querySelector<HTMLElement>(".analysis-run-table__title");
    if (title) {
      heading = heading ?? document.createElement("h3");
      heading.className = "analysis-run-table__title";
      heading.textContent = title;
      if (!heading.parentElement) element.append(heading);
    } else {
      heading?.remove();
    }

    if (props.filterable !== false) renderStatusFilter(element, context);
    else {
      const filter = element.querySelector<HTMLElement>(".analysis-run-table__filter");
      if (filter) {
        context.disposeElementTree(filter);
        filter.remove();
      }
    }

    let table = element.querySelector<HTMLTableElement>("table");
    if (!table) {
      table = document.createElement("table");
      table.setAttribute("aria-label", title || "Soyuz runs");
      element.append(table);
    }
    let thead = table.querySelector("thead");
    let tbody = table.querySelector("tbody");
    if (!thead) {
      thead = document.createElement("thead");
      table.append(thead);
    }
    if (!tbody) {
      tbody = document.createElement("tbody");
      table.append(tbody);
    }
    renderRunTableHeader(thead, context);

    const rows = Array.isArray(props.rows) ? props.rows.filter(isRunRow) : [];
    const stateStatus = context.store.get("$runStatus");
    const selectedRunId = context.store.get("$selectedRunId");
    const sortKey = SORT_OPTIONS.includes(context.store.get("$runSort") as typeof SORT_OPTIONS[number])
      ? context.store.get("$runSort") as typeof SORT_OPTIONS[number]
      : "createdAt";
    const filtered = rows.filter((row) => stateStatus === "all" || !STATUS_OPTIONS.includes(stateStatus as typeof STATUS_OPTIONS[number]) || row.status === stateStatus);
    const healthFilter = enumValue(props.healthFilter, ["all", "healthy", "suspect_stalled", "unknown"], "all");
    const healthyRows = filtered.filter((row) => healthFilter === "all" || row.operationalHealth === healthFilter);
    const sorted = [...healthyRows].sort((a, b) => compareRunRows(a, b, sortKey));
    reconcileRunRows(tbody, sorted, String(selectedRunId ?? ""), props.selectable !== false, context);
    return element;
  },
  StatusChart: (existing, _node, props) => {
    const element = reuse(existing, "section", "card analysis-status-chart");
    const title = stringValue(props.title, 120);
    const heading = ensureChild(element, "h3", "analysis-status-chart__title");
    heading.textContent = title || "Run status distribution";
    let list = element.querySelector<HTMLUListElement>("ul");
    if (!list) {
      list = document.createElement("ul");
      list.className = "analysis-status-chart__list";
      element.append(list);
    }
    const items = Array.isArray(props.items) ? props.items.filter(isStatusCount) : [];
    const total = items.reduce((sum, item) => sum + item.count, 0);
    reconcileItems(list, items, (item) => item.status, (item) => {
      const row = document.createElement("li");
      row.className = "analysis-status-chart__item";
      row.dataset.itemKey = item.status;
      const label = document.createElement("span");
      label.className = "analysis-status-chart__label";
      const bar = document.createElement("progress");
      bar.className = "analysis-status-chart__bar";
      bar.max = 100;
      const value = document.createElement("span");
      value.className = "analysis-status-chart__value";
      row.append(label, bar, value);
      return row;
    }, (row, item) => {
      const label = row.querySelector<HTMLElement>(".analysis-status-chart__label");
      const bar = row.querySelector<HTMLProgressElement>("progress");
      const value = row.querySelector<HTMLElement>(".analysis-status-chart__value");
      if (label) label.textContent = item.status.replaceAll("_", " ");
      if (bar) {
        bar.value = total > 0 ? Math.round(item.count * 100 / total) : 0;
        bar.setAttribute("aria-label", `${item.count} ${item.status.replaceAll("_", " ")} runs`);
      }
      if (value) value.textContent = String(item.count);
    });
    return element;
  },
  EventTimeline: (existing, _node, props) => {
    const element = reuse(existing, "section", "card analysis-event-timeline");
    const title = ensureChild(element, "h3", "analysis-event-timeline__title");
    title.textContent = stringValue(props.title, 120) || "Run event history";
    let list = element.querySelector<HTMLOListElement>("ol");
    if (!list) {
      list = document.createElement("ol");
      list.className = "analysis-event-timeline__list";
      element.append(list);
    }
    const events = Array.isArray(props.events) ? props.events.filter(isRunEvent) : [];
    reconcileItems(list, events, (event) => event.eventId, () => {
      const item = document.createElement("li");
      item.className = "analysis-event-timeline__item";
      item.dataset.itemKey = "";
      const heading = document.createElement("strong");
      const time = document.createElement("time");
      const details = document.createElement("p");
      item.append(heading, time, details);
      return item;
    }, (item, event) => {
      const heading = item.querySelector("strong");
      const time = item.querySelector("time");
      const details = item.querySelector("p");
      if (heading) heading.textContent = [event.type, event.stage, event.step].filter(Boolean).join(" · ");
      if (time) {
        time.dateTime = event.timestamp;
        time.textContent = event.timestamp;
      }
      if (details) {
        const payload = Object.entries(event.payload).slice(0, 12).map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
        details.textContent = payload;
        details.hidden = payload.length === 0;
      }
    });
    const empty = ensureChild(element, "p", "analysis-event-timeline__empty");
    empty.textContent = events.length ? "" : "Select a run to see its recorded events.";
    empty.hidden = events.length > 0;
    return element;
  },
  DecisionSummary: (existing, _node, props) => {
    const element = reuse(existing, "article", "card analysis-jev-summary");
    const title = ensureChild(element, "h3", "analysis-jev__title");
    const summary = ensureChild(element, "p", "analysis-jev-summary__value");
    title.textContent = stringValue(props.title, 160);
    const answer = props.answer as Record<string, unknown>;
    if (answer.type === "noul" && typeof answer.noul === "number") {
      summary.textContent = `True: ${formatProbability(answer.noul)} · False: ${formatProbability(1 - answer.noul)}`;
    } else if (answer.type === "choice" && typeof answer.choice === "string") {
      summary.textContent = `Selected: ${stringValue(answer.choice, 100)}`;
    } else if (answer.type === "score" && typeof answer.score === "number") {
      summary.textContent = `Score: ${formatScore(answer.score)}`;
    } else {
      summary.textContent = "No validated answer is available.";
    }
    return element;
  },
  ChoiceProbabilities: (existing, _node, props) => {
    const element = reuse(existing, "section", "card analysis-jev-probabilities");
    const title = ensureChild(element, "h3", "analysis-jev__title");
    title.textContent = stringValue(props.title, 160);
    const list = ensureChild(element, "ul", "analysis-jev-probabilities__list") as HTMLUListElement;
    const probabilities = recordValue(props.probabilities);
    const labels = recordValue(props.labels);
    renderProbabilityItems(list, probabilities, labels);
    return element;
  },
  ScoreScale: (existing, _node, props) => {
    const element = reuse(existing, "section", "card analysis-jev-score");
    const title = ensureChild(element, "h3", "analysis-jev__title");
    title.textContent = stringValue(props.title, 160);
    const score = typeof props.score === "number" ? props.score : 0;
    const legend = recordValue(props.legend);
    const probabilities = recordValue(props.probabilities);
    const maximum = Math.max(0, Object.keys(legend).length - 1);
    const scoreText = ensureChild(element, "p", "analysis-jev-score__value");
    scoreText.textContent = `Score ${formatScore(score)} of ${maximum}`;
    const scale = ensureChild(element, "progress", "analysis-jev-score__scale") as HTMLProgressElement;
    scale.max = maximum || 1;
    scale.value = Math.min(maximum, score);
    scale.setAttribute("aria-label", `${scoreText.textContent}; scale from 0 to ${maximum}`);
    const list = ensureChild(element, "ul", "analysis-jev-probabilities__list") as HTMLUListElement;
    const labels = Object.fromEntries(Object.entries(legend).map(([key, value]) => [key, value]));
    renderProbabilityItems(list, probabilities, labels);
    return element;
  },
  ConfidenceDisplay: (existing, _node, props) => {
    const element = reuse(existing, "section", "analysis-jev-confidence");
    const title = ensureChild(element, "span", "analysis-jev-confidence__title");
    const value = ensureChild(element, "span", "analysis-jev-confidence__value");
    const meter = ensureChild(element, "progress", "analysis-jev-confidence__meter") as HTMLProgressElement;
    title.textContent = stringValue(props.title, 160);
    if (typeof props.confidence === "number") {
      value.textContent = formatProbability(props.confidence);
      meter.max = 1;
      meter.value = props.confidence;
      meter.setAttribute("aria-label", `${title.textContent}: ${value.textContent}`);
      meter.hidden = false;
    } else {
      value.textContent = "Not provided";
      meter.hidden = true;
      meter.removeAttribute("aria-label");
    }
    return element;
  },
  Notice: (existing, _node, props) => {
    const tone = enumValue(props.tone, ["info", "empty", "warning", "danger"], "info");
    const element = reuse(existing, "p", `notice notice--${tone}`);
    element.setAttribute("role", "status");
    element.textContent = stringValue(props.text, 500);
    return element;
  },
  ActionButton: (existing, _node, props, context) => {
    const element = reuse(existing, "button", "button button--secondary analysis-action-button");
    (element as HTMLButtonElement).type = "button";
    element.textContent = stringValue(props.text, 80);
    element.addEventListener("click", () => {
      if (!Array.isArray(props.actions)) return;
      for (const action of props.actions) {
        if (action && typeof action === "object" && !Array.isArray(action) && typeof (action as { type?: unknown }).type === "string") {
          const candidate = action as { type: string; params?: Record<string, unknown> };
          context.dispatchAction({ type: candidate.type, params: candidate.params });
        }
      }
    }, { signal: context.bindEvents(element) });
    return element;
  },
};

function renderStatusFilter(element: HTMLElement, context: Parameters<NativeComponentRenderer>[3]): void {
  let wrapper = element.querySelector<HTMLElement>(".analysis-run-table__filter");
  if (!wrapper) {
    wrapper = document.createElement("label");
    wrapper.className = "analysis-run-table__filter";
    wrapper.textContent = "Filter by status ";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Filter runs by status");
    for (const value of STATUS_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "all" ? "All statuses" : value.replaceAll("_", " ");
      select.append(option);
    }
    wrapper.append(select);
    element.prepend(wrapper);
  }
  const select = wrapper.querySelector("select");
  if (!select) return;
  const status = context.store.get("$runStatus");
  const selectedStatus = STATUS_OPTIONS.includes(status as typeof STATUS_OPTIONS[number]) ? String(status) : "all";
  for (const option of Array.from(select.options)) {
    if (option.value === selectedStatus) option.setAttribute("selected", "");
    else option.removeAttribute("selected");
  }
  select.addEventListener("change", () => context.store.set("$runStatus", select?.value ?? "all"), { signal: context.bindEvents(select) });
}

function renderRunTableHeader(thead: HTMLTableSectionElement, context: Parameters<NativeComponentRenderer>[3]): void {
  let row = thead.querySelector("tr");
  if (!row) {
    row = document.createElement("tr");
    thead.append(row);
  }
  const columns = [["displayId", "Run"], ["status", "Status"], ["operationalHealth", "Health"], ["durationMs", "Duration"], ["repoUrl", "Repository"], ["ref", "Ref"], ["createdAt", "Created"], ["failureClass", "Failure class"]] as const;
  if (row.children.length !== columns.length) {
    context.disposeElementTree(row);
    row.replaceChildren();
    for (const _column of columns) row.append(document.createElement("th"));
  }
  columns.forEach(([key, label], index) => {
    const cell = row?.children.item(index) as HTMLTableCellElement | null;
    if (!cell) return;
    cell.setAttribute("scope", "col");
    if ((SORT_OPTIONS as readonly string[]).includes(key)) {
      let button = cell.querySelector<HTMLButtonElement>("button");
      if (!button) {
        button = document.createElement("button");
        cell.replaceChildren(button);
      }
      button.type = "button";
      button.className = "analysis-run-table__sort";
      button.textContent = label;
      button.addEventListener("click", () => context.store.set("$runSort", key), { signal: context.bindEvents(button) });
    } else {
      cell.textContent = label;
    }
  });
}

function reconcileRunRows(
  tbody: HTMLTableSectionElement,
  rows: RunRow[],
  selectedRunId: string,
  selectable: boolean,
  context: Parameters<NativeComponentRenderer>[3],
): void {
  reconcileItems(tbody, rows, (row) => row.runId, (row) => {
    const tr = document.createElement("tr");
    tr.dataset.itemKey = row.runId;
    for (let column = 0; column < 8; column += 1) tr.append(document.createElement("td"));
    return tr;
  }, (tr, row) => {
    const cells = tr.querySelectorAll<HTMLTableCellElement>("td");
    tr.classList.toggle("analysis-run-table__row--selected", selectedRunId === row.runId);
    const runCell = cells.item(0);
    if (runCell) {
      if (selectable) {
        let button = runCell.querySelector<HTMLButtonElement>("button");
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.className = "analysis-run-table__select";
          runCell.replaceChildren(button);
        }
        button.textContent = row.displayId;
        button.setAttribute("aria-pressed", String(selectedRunId === row.runId));
        button.setAttribute("aria-label", `Select run ${row.displayId}`);
        button.addEventListener("click", () => context.dispatchAction({ type: "select_run", params: { runId: row.runId } }), { signal: context.bindEvents(button) });
      } else runCell.textContent = row.displayId;
    }
    setCell(cells.item(1), row.status.replaceAll("_", " "));
    setCell(cells.item(2), row.operationalHealth.replaceAll("_", " "));
    setCell(cells.item(3), formatDuration(runDurationMs(row)));
    setCell(cells.item(4), row.repoUrl);
    setCell(cells.item(5), row.ref);
    setCell(cells.item(6), row.createdAt);
    setCell(cells.item(7), row.failureClass ?? "—");
  }, (element) => context.disposeElementTree(element));
}

function reconcileItems<T>(
  parent: HTMLElement,
  values: T[],
  getKey: (value: T) => string,
  create: (value: T) => HTMLElement,
  update: (element: HTMLElement, value: T) => void,
  dispose: (element: HTMLElement) => void = () => undefined,
): void {
  const old = new Map<string, HTMLElement>();
  for (const child of Array.from(parent.children)) {
    const element = child as HTMLElement;
    if (element.dataset.itemKey) old.set(element.dataset.itemKey, element);
  }
  const next: HTMLElement[] = [];
  for (const value of values) {
    const key = getKey(value).slice(0, 120);
    let element = old.get(key);
    old.delete(key);
    if (!element) element = create(value);
    element.dataset.itemKey = key;
    update(element, value);
    next.push(element);
  }
  for (const element of old.values()) {
    dispose(element);
    element.remove();
  }
  for (let index = 0; index < next.length; index += 1) {
    const element = next[index];
    const atPosition = parent.children.item(index);
    if (atPosition !== element) parent.insertBefore(element, atPosition);
  }
  while (parent.children.length > next.length) {
    const element = parent.lastElementChild as HTMLElement | null;
    if (!element) break;
    dispose(element);
    element.remove();
  }
}

interface RunRow {
  runId: string;
  displayId: string;
  status: string;
  operationalHealth: "unknown" | "healthy" | "suspect_stalled";
  repoUrl: string;
  ref: string;
  failureClass: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

function isRunRow(value: unknown): value is RunRow {
  return Boolean(value && typeof value === "object"
    && typeof (value as RunRow).runId === "string"
    && typeof (value as RunRow).displayId === "string"
    && typeof (value as RunRow).status === "string"
    && ["unknown", "healthy", "suspect_stalled"].includes((value as RunRow).operationalHealth)
    && typeof (value as RunRow).repoUrl === "string"
    && typeof (value as RunRow).ref === "string"
    && typeof (value as RunRow).createdAt === "string");
}

interface StatusCount { status: string; count: number }
function isStatusCount(value: unknown): value is StatusCount {
  return Boolean(value && typeof value === "object" && typeof (value as StatusCount).status === "string"
    && Number.isInteger((value as StatusCount).count) && (value as StatusCount).count >= 0);
}

interface RunEvent {
  eventId: string;
  type: string;
  stage: string | null;
  step: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}
function isRunEvent(value: unknown): value is RunEvent {
  return Boolean(value && typeof value === "object" && typeof (value as RunEvent).eventId === "string"
    && typeof (value as RunEvent).type === "string" && typeof (value as RunEvent).timestamp === "string"
    && (value as RunEvent).payload && typeof (value as RunEvent).payload === "object");
}

function compareRunRows(a: RunRow, b: RunRow, key: typeof SORT_OPTIONS[number]): number {
  if (key === "createdAt") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (key === "durationMs") return (runDurationMs(b) ?? -1) - (runDurationMs(a) ?? -1);
  return String(a[key]).localeCompare(String(b[key]), undefined, { numeric: true, sensitivity: "base" });
}

function runDurationMs(row: RunRow): number | null {
  if (!row.startedAt || !row.completedAt) return null;
  const startedAt = Date.parse(row.startedAt);
  const completedAt = Date.parse(row.completedAt);
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? completedAt - startedAt
    : null;
}

function formatDuration(value: number | null): string {
  if (value === null) return "Unavailable";
  if (value < 1_000) return `${value} ms`;
  const seconds = value / 1_000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`;
}

function reuse(existing: HTMLElement | null, tag: string, className: string): HTMLElement {
  const element = existing && existing.tagName.toLowerCase() === tag
    ? existing
    : document.createElement(tag) as HTMLElement;
  element.className = className;
  return element;
}

function ensureChild<T extends HTMLElement>(parent: HTMLElement, tag: string, className: string): T {
  const selector = `.${className.split(" ")[0]}`;
  let child = parent.querySelector<T>(selector);
  if (!child) {
    child = document.createElement(tag) as T;
    child.className = className;
    parent.append(child);
  }
  return child;
}

function setCell(cell: HTMLTableCellElement | null, value: string): void {
  if (cell) cell.textContent = value.slice(0, 500);
}

function keyFor(node: ElementNode): string {
  return typeof node.statementId === "string" ? node.statementId : node.typeName;
}

function stringValue(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function formatMetric(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat().format(value);
  return typeof value === "string" ? value.slice(0, 100) : "Unavailable";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function renderProbabilityItems(
  list: HTMLUListElement,
  probabilities: Record<string, unknown>,
  labels: Record<string, unknown>,
): void {
  list.replaceChildren();
  for (const [key, rawValue] of Object.entries(probabilities).slice(0, 12)) {
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0 || rawValue > 1) continue;
    const item = document.createElement("li");
    item.className = "analysis-jev-probabilities__item";
    const label = document.createElement("span");
    label.textContent = stringValue(labels[key] ?? key, 200);
    const bar = document.createElement("progress");
    bar.max = 1;
    bar.value = rawValue;
    bar.setAttribute("aria-label", `${label.textContent}: ${formatProbability(rawValue)}`);
    const value = document.createElement("span");
    value.className = "analysis-jev-probabilities__value";
    value.textContent = formatProbability(rawValue);
    item.append(label, bar, value);
    list.append(item);
  }
}

function formatProbability(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatScore(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}
