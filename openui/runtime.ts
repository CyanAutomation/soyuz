import {
  createParser,
  createQueryManager,
  createStore,
  evaluate,
  evaluateRoot,
  walkAST,
  type ASTNode,
  type ElementNode,
  type EvalContext,
  type ParseResult,
  type QueryNode,
  type QueryManager,
  type Store,
} from "@openuidev/lang-core";
import { soyuzOpenUILibrary } from "./library";
import { isSoyuzToolName, toolInputSchemas, toolOutputSchemas, type SoyuzToolName } from "./tools";
import { OPENUI_MAX_COMPONENTS, OPENUI_MAX_DEPTH, OPENUI_MAX_PROGRAM_CHARS, OPENUI_MAX_QUERIES } from "./library";

export interface ProgramValidation {
  ok: boolean;
  result?: ParseResult;
  reason?: string;
}

export function validateGeneratedProgram(source: string, options: { allowJev?: boolean } = {}): ProgramValidation {
  if (source.length === 0 || source.length > OPENUI_MAX_PROGRAM_CHARS) return { ok: false, reason: "The generated interface exceeded the supported size." };
  let result: ParseResult;
  try {
    result = createParser(soyuzOpenUILibrary.toJSONSchema(), "Stack").parse(source);
  } catch {
    return { ok: false, reason: "The generated interface could not be parsed." };
  }
  if (!result.root) return { ok: false, reason: "The generated interface has no usable root component." };
  if (result.meta.incomplete || result.meta.unresolved.length > 0) return { ok: false, reason: "The generated interface is incomplete or refers to missing values." };
  if (result.meta.errors.some((error) => error.severity !== "warning")) return { ok: false, reason: "The generated interface contains unsupported or invalid components." };
  if (result.meta.statementCount > 80 || result.stateDeclarations && Object.keys(result.stateDeclarations).length > 10) {
    return { ok: false, reason: "The generated interface contains too many statements or state variables." };
  }
  if (result.mutationStatements.length > 0) return { ok: false, reason: "Generated mutations are disabled." };
  if (result.queryStatements.length > OPENUI_MAX_QUERIES || result.queryStatements.some((query) => !query.complete)) {
    return { ok: false, reason: "The generated interface contains incomplete or excessive queries." };
  }
  if (countProgramNodes(result.root) > 2_000) return { ok: false, reason: "The generated interface is too complex to evaluate." };
  if (!validateStateDeclarations(result.stateDeclarations)) return { ok: false, reason: "The generated state is invalid or too large." };

  const queryNames = new Set(result.queryStatements.map((query) => query.statementId));
  const store = createStore();
  try {
    store.initialize({ ...defaultDashboardState(), ...result.stateDeclarations }, {});
    const context = evaluationContext(store, { getResult: () => undefined });
    const queryTools = new Map<string, SoyuzToolName>();
    for (const query of result.queryStatements) {
      try {
        const toolName = query.toolAST ? evaluate(query.toolAST, context.ctx) : null;
        if (!isSoyuzToolName(toolName)) return { ok: false, reason: "The generated interface requested an unsupported data query." };
        if (toolName === "jev_decisions" && !options.allowJev) {
          return { ok: false, reason: "JEV decisions may only be requested from the explicit analysis control." };
        }
        if (toolName === "jev_decisions" && ((query.deps?.length ?? 0) > 0 || query.refreshAST)) {
          return { ok: false, reason: "JEV decisions cannot run from state-dependent or refreshing queries." };
        }
        queryTools.set(query.statementId, toolName);
        const rawArgs = query.argsAST ? evaluate(query.argsAST, context.ctx) : {};
        if (!validateToolArgs(toolName, rawArgs)) return { ok: false, reason: "A generated data query had invalid arguments." };
        const defaults = query.defaultsAST ? evaluate(query.defaultsAST, context.ctx) : undefined;
        if (!validateQueryDefaults(toolName, defaults)) return { ok: false, reason: "A generated query had unsafe default data." };
        if (query.refreshAST) {
          const interval = evaluate(query.refreshAST, context.ctx);
          if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 1 || interval > 3_600) {
            return { ok: false, reason: "A generated query requested an invalid refresh interval." };
          }
        }
      } catch {
        return { ok: false, reason: "A generated query could not be evaluated safely." };
      }
    }
    const jevQueryNames = new Set([...queryTools.entries()].filter(([, name]) => name === "jev_decisions").map(([statementId]) => statementId));
    const componentError = validateComponentDataSources(result.root, queryNames, jevQueryNames);
    if (componentError) return { ok: false, reason: componentError };
    return { ok: true, result };
  } catch {
    return { ok: false, reason: "The generated interface could not be evaluated safely." };
  } finally {
    store.dispose();
  }
}

function validateComponentDataSources(root: ElementNode, queryNames: Set<string>, jevQueryNames: Set<string>): string | null {
  const stack: Array<{ node: ElementNode; depth: number }> = [{ node: root, depth: 1 }];
  let count = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    count += 1;
    if (count > OPENUI_MAX_COMPONENTS || depth > OPENUI_MAX_DEPTH) return "The generated interface exceeded rendering limits.";
    if (node.typeName === "RunTable" && !containsQueryRef(node.props.rows, queryNames)) {
      return "Run tables must display data returned by an approved read-only query.";
    }
    if (node.typeName === "StatusChart" && !containsQueryRef(node.props.items, queryNames)) {
      return "Status charts must derive counts from an approved run query.";
    }
    if (node.typeName === "EventTimeline" && !containsQueryRef(node.props.events, queryNames)) {
      return "Event timelines must display data returned by an approved event query.";
    }
    if (node.typeName === "DecisionSummary" && !containsQueryRef(node.props.answer, jevQueryNames)) {
      return "Decision summaries must display an answer returned by an approved JEV query.";
    }
    if (node.typeName === "ChoiceProbabilities" && !containsQueryRef(node.props.probabilities, jevQueryNames)) {
      return "Decision probabilities must come from an approved JEV query.";
    }
    if (node.typeName === "ScoreScale"
      && (!containsQueryRef(node.props.score, jevQueryNames)
        || !containsQueryRef(node.props.legend, jevQueryNames)
        || !containsQueryRef(node.props.probabilities, jevQueryNames))) {
      return "Decision scores and their scale must come from an approved JEV query.";
    }
    if (node.typeName === "ConfidenceDisplay" && !containsQueryRef(node.props.confidence, jevQueryNames)) {
      return "Decision confidence must come from an approved JEV query.";
    }
    if (node.typeName === "MetricCard" && !isUnavailableLiteral(node.props.value) && !containsQueryRef(node.props.value, queryNames)) {
      return "Metric cards must derive values from an approved query or function.";
    }
    for (const child of nestedElements(node.props)) stack.push({ node: child, depth: depth + 1 });
  }
  return null;
}

function nestedElements(value: unknown, depth = 0): ElementNode[] {
  if (depth > 32) return [];
  if (isElementNode(value)) return [value];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap((entry) => nestedElements(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value).slice(0, 100).flatMap((entry) => nestedElements(entry, depth + 1));
  }
  return [];
}

function containsQueryRef(value: unknown, queryNames: Set<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsQueryRef(entry, queryNames));
  if (isElementNode(value)) return Object.values(value.props).some((entry) => containsQueryRef(entry, queryNames));
  if ("k" in value && typeof (value as { k?: unknown }).k === "string") {
    let found = false;
    try {
      walkAST(value as ASTNode, (node) => {
        if (node.k === "RuntimeRef" && node.refType === "query" && queryNames.has(node.n)) found = true;
      });
    } catch {
      return false;
    }
    return found;
  }
  return false;
}

function isUnavailableLiteral(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "k" in value
    && (value as ASTNode).k === "Str"
    && ["Unavailable", "Not available", "No data", "N/A"].includes((value as Extract<ASTNode, { k: "Str" }>).v));
}

function validateToolArgs(toolName: SoyuzToolName, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const args = { ...(value as Record<string, unknown>) };
  if (toolName === "list_runs" && args.status === "all") delete args.status;
  if (toolName !== "list_runs" && typeof args.runId === "string" && args.runId === "") {
    return toolName === "get_run" || toolName === "get_run_events" || toolName === "get_run_artifacts";
  }
  return toolInputSchemas[toolName].safeParse(args).success;
}

function validateQueryDefaults(toolName: SoyuzToolName, value: unknown): boolean {
  switch (toolName) {
    case "list_runs":
      return isPlainRecord(value) && Array.isArray(value.runs) && value.runs.length === 0 && value.nextCursor === null;
    case "get_run":
      return value === null;
    case "get_run_events":
      return isPlainRecord(value) && Array.isArray(value.events) && value.events.length === 0 && value.nextAfter === 0 && value.hasMore === false;
    case "get_run_artifacts":
      return isPlainRecord(value) && Array.isArray(value.artifacts) && value.artifacts.length === 0;
    case "jev_decisions":
      return isPlainRecord(value) && value.model === "" && isPlainRecord(value.answers) && Object.keys(value.answers).length === 0;
  }
}

function validateStateDeclarations(values: Record<string, unknown>): boolean {
  try {
    for (const [key, value] of Object.entries(values)) {
      if (!/^\$[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) return false;
      const serialized = JSON.stringify(value);
      if (serialized === undefined || serialized.length > 2_000) return false;
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)
        && !(Array.isArray(value) && value.length <= 20 && value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function countProgramNodes(value: unknown, depth = 0): number {
  if (depth > 32) return 2_001;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countProgramNodes(item, depth + 1), 1);
  if (!value || typeof value !== "object") return 1;
  return 1 + Object.values(value).reduce((sum, item) => sum + countProgramNodes(item, depth + 1), 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isElementNode(value: unknown): value is ElementNode {
  return Boolean(value && typeof value === "object" && (value as Partial<ElementNode>).type === "element"
    && typeof (value as Partial<ElementNode>).typeName === "string");
}

export interface SoyuzOpenUIRuntime {
  readonly store: Store;
  readonly queryManager: QueryManager;
  setProgram(result: ParseResult): void;
  getRoot(): ElementNode | null;
  refresh(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createSoyuzOpenUIRuntime(
  accessToken: string,
  fetcher: typeof fetch = fetch,
  onUnauthorized: () => void = () => undefined,
): SoyuzOpenUIRuntime {
  const store = createStore();
  let currentProgram: ParseResult | null = null;
  const queryManager = createQueryManager({
    callTool: (toolName, args) => executeDashboardTool(accessToken, toolName, args, fetcher, onUnauthorized),
  });
  const functions = createRuntimeFunctions();
  const ctx = {
    getState: (name: string) => store.get(name),
    resolveRef: (name: string) => queryManager.getResult(name),
    functions,
    reportError: () => undefined,
  };
  const onStateChange = store.subscribe(() => syncQueries());

  function setProgram(result: ParseResult): void {
    currentProgram = result;
    store.initialize({ ...defaultDashboardState(), ...result.stateDeclarations }, store.getSnapshot());
    syncQueries();
  }

  function syncQueries(): void {
    if (!currentProgram) return;
    const queries = currentProgram.queryStatements.slice(0, OPENUI_MAX_QUERIES).flatMap((query): QueryNode[] => {
      if (!query.complete) return [];
      try {
        const toolName = query.toolAST ? evaluate(query.toolAST, ctx) : null;
        if (!isSoyuzToolName(toolName)) return [];
        const args = query.argsAST ? evaluate(query.argsAST, ctx) : {};
        const defaults = query.defaultsAST ? evaluate(query.defaultsAST, ctx) : undefined;
        const refreshValue = query.refreshAST ? evaluate(query.refreshAST, ctx) : undefined;
        const refreshInterval = typeof refreshValue === "number" && Number.isFinite(refreshValue)
          ? Math.max(15, Math.min(60, Math.round(refreshValue)))
          : undefined;
        const deps = Object.fromEntries((query.deps ?? []).map((name) => [name, store.get(name.startsWith("$") ? name : `$${name}`)]));
        return [{
          statementId: query.statementId,
          toolName,
          args,
          defaults,
          deps,
          ...(refreshInterval === undefined ? {} : { refreshInterval }),
          complete: true,
        }];
      } catch {
        return [];
      }
    });
    queryManager.evaluateQueries(queries);
  }

  return {
    store,
    queryManager,
    setProgram,
    getRoot() {
      return currentProgram ? evaluateRoot(currentProgram, { ctx, library: soyuzOpenUILibrary, store }) : null;
    },
    refresh() {
      queryManager.invalidate();
      syncQueries();
    },
    subscribe(listener) {
      const stopState = store.subscribe(listener);
      const stopQueries = queryManager.subscribe(listener);
      return () => { stopState(); stopQueries(); };
    },
    dispose() {
      onStateChange();
      queryManager.dispose();
      store.dispose();
      currentProgram = null;
    },
  };
}

function evaluationContext(store: Store, queryManager: Pick<QueryManager, "getResult">): EvalContext {
  return {
    ctx: {
      getState: (name) => store.get(name),
      resolveRef: (name) => queryManager.getResult(name),
      functions: createRuntimeFunctions(),
    },
    library: soyuzOpenUILibrary,
    store,
  };
}

function createRuntimeFunctions(): NonNullable<EvalContext["ctx"]["functions"]> {
  const schemas = soyuzOpenUILibrary.toJSONSchema().functions ?? {};
  return Object.fromEntries(Object.entries(soyuzOpenUILibrary.functions ?? {}).map(([name, definition]) => [
    name,
    { ...schemas[name], fn: definition.fn },
  ]));
}

function defaultDashboardState(): Record<string, unknown> {
  return { "$runStatus": "all", "$selectedRunId": "", "$runSort": "createdAt" };
}

async function executeDashboardTool(
  accessToken: string,
  rawName: string,
  rawArgs: Record<string, unknown>,
  fetcher: typeof fetch,
  onUnauthorized: () => void,
): Promise<unknown> {
  if (!isSoyuzToolName(rawName)) throw new Error("Tool is not available.");
  if (["get_run", "get_run_events", "get_run_artifacts"].includes(rawName) && rawArgs.runId === "") return emptyToolResult(rawName);
  const args = { ...rawArgs };
  if (rawName === "list_runs" && args.status === "all") delete args.status;

  const query = new URLSearchParams();
  let path: string;
  let method: "GET" | "POST" = "GET";
  let body: string | undefined;
  switch (rawName) {
    case "list_runs": {
      const parsed = toolInputSchemas.list_runs.safeParse(args);
      if (!parsed.success) throw new Error("Tool arguments are invalid.");
      query.set("limit", String(parsed.data.limit ?? 30));
      if (parsed.data.status) query.set("status", parsed.data.status);
      if (parsed.data.cursor) query.set("cursor", parsed.data.cursor);
      path = `/dashboard/api/runs?${query.toString()}`;
      break;
    }
    case "get_run": {
      const parsed = toolInputSchemas.get_run.safeParse(args);
      if (!parsed.success) throw new Error("Tool arguments are invalid.");
      path = `/dashboard/api/runs/${encodeURIComponent(parsed.data.runId)}`;
      break;
    }
    case "get_run_events": {
      const parsed = toolInputSchemas.get_run_events.safeParse(args);
      if (!parsed.success) throw new Error("Tool arguments are invalid.");
      query.set("limit", String(parsed.data.limit ?? 50));
      query.set("after", String(parsed.data.after ?? 0));
      path = `/dashboard/api/runs/${encodeURIComponent(parsed.data.runId)}/events?${query.toString()}`;
      break;
    }
    case "get_run_artifacts": {
      const parsed = toolInputSchemas.get_run_artifacts.safeParse(args);
      if (!parsed.success) throw new Error("Tool arguments are invalid.");
      path = `/dashboard/api/runs/${encodeURIComponent(parsed.data.runId)}/artifacts`;
      break;
    }
    case "jev_decisions": {
      const parsed = toolInputSchemas.jev_decisions.safeParse(args);
      if (!parsed.success) throw new Error("Tool arguments are invalid.");
      path = "/dashboard/api/analysis/decisions";
      method = "POST";
      body = JSON.stringify(parsed.data);
      break;
    }
  }

  const response = await fetcher(path, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) onUnauthorized();
    throw new Error(response.status === 401 ? "Session expired." : "Run data is unavailable.");
  }
  const envelope: unknown = await response.json();
  const data = envelope && typeof envelope === "object" && "data" in envelope ? (envelope as { data: unknown }).data : envelope;
  const validated = toolOutputSchemas[rawName].safeParse(data);
  if (!validated.success) throw new Error("Soyuz returned data with an unsupported shape.");
  return validated.data;
}

function emptyToolResult(toolName: SoyuzToolName): unknown {
  switch (toolName) {
    case "list_runs": return { runs: [], nextCursor: null };
    case "get_run": return null;
    case "get_run_events": return { events: [], nextAfter: 0, hasMore: false };
    case "get_run_artifacts": return { artifacts: [] };
    case "jev_decisions": return { model: "", answers: {} };
  }
}
