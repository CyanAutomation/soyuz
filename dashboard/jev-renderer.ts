export type JevProfileId = "run_operations_triage_v1" | "kaseki_output_review_v1" | "kaseki_output_review_v2" | "run_retry_review_v1";

interface AnswerView {
  key: string;
  title: string;
  type: "noul" | "choice" | "score";
  labels?: Record<string, string>;
}

export const JEV_PROFILE_VIEWS: Readonly<Record<JevProfileId, { title: string; answers: readonly AnswerView[] }>> = {
  run_operations_triage_v1: {
    title: "Run operations triage",
    answers: [
      { key: "needs_followup", title: "Needs followup", type: "noul" },
      { key: "likely_area", title: "Likely area", type: "choice", labels: { execution: "Kaseki execution", control_plane: "Soyuz control plane", unknown: "Unknown" } },
      { key: "severity", title: "Severity", type: "score" },
    ],
  },
  kaseki_output_review_v1: {
    title: "Kaseki output review",
    answers: [
      { key: "summary_specificity", title: "Summary specificity", type: "noul" },
      { key: "outcome_alignment", title: "Outcome alignment", type: "choice", labels: { consistent: "Consistent", unclear: "Unclear", inconsistent: "Inconsistent" } },
      { key: "evidence_strength", title: "Evidence strength", type: "score" },
    ],
  },
  kaseki_output_review_v2: {
    title: "Kaseki output and outcome review",
    answers: [
      { key: "summary_specificity", title: "Summary specificity", type: "noul" },
      { key: "outcome_alignment", title: "Outcome alignment", type: "choice", labels: { consistent: "Consistent", unclear: "Unclear", inconsistent: "Inconsistent" } },
      { key: "evidence_strength", title: "Evidence strength", type: "score" },
      { key: "recorded_outcome", title: "Recorded outcome score", type: "score" },
    ],
  },
  run_retry_review_v1: {
    title: "Run retry comparison",
    answers: [
      { key: "recovery", title: "Recovery assessment", type: "choice", labels: { recovered: "Recovered", partial: "Partially recovered", not_recovered: "Not recovered", unclear: "Unclear" } },
      { key: "evidence_strength", title: "Evidence strength", type: "score" },
      { key: "needs_followup", title: "Needs followup", type: "noul" },
    ],
  },
};

export function renderJevResult(
  target: HTMLElement,
  profileId: JevProfileId,
  result: { model: string; answers: Record<string, unknown> },
): void {
  const document = target.ownerDocument;
  const profile = JEV_PROFILE_VIEWS[profileId];
  const fragment = document.createDocumentFragment();
  const advisory = document.createElement("p");
  advisory.className = "notice notice--warning";
  advisory.setAttribute("role", "note");
  advisory.textContent = "Advisory result. Verify the run record before taking consequential action.";
  fragment.appendChild(advisory);

  for (const view of profile.answers) {
    const answer = asRecord(result.answers[view.key]);
    const card = document.createElement("article");
    card.className = "card card--padded jev-answer";
    const heading = document.createElement("h3");
    heading.className = "jev-answer__title";
    heading.textContent = view.title;
    card.appendChild(heading);
    const choice = answer?.type === "choice" && typeof answer.choice === "string" ? answer.choice : null;
    const score = answer?.type === "score" && typeof answer.score === "number" ? answer.score : null;
    const noul = answer?.type === "noul" && typeof answer.noul === "number" ? answer.noul : null;
    const value = document.createElement("p");
    value.className = "jev-answer__value";
    if (choice !== null) value.textContent = `Selected: ${view.labels?.[choice] ?? choice}`;
    else if (score !== null) value.textContent = `Score: ${score.toFixed(2)}`;
    else if (noul !== null) value.textContent = `True: ${formatProbability(noul)} · False: ${formatProbability(1 - noul)}`;
    else value.textContent = "No validated answer is available.";
    card.appendChild(value);

    if (answer && isRecord(answer.probabilities)) {
      const list = document.createElement("ul");
      list.className = "jev-probabilities__list";
      for (const [key, probability] of Object.entries(answer.probabilities)) {
        if (typeof probability !== "number" || !Number.isFinite(probability)) continue;
        const row = document.createElement("li");
        row.className = "jev-probabilities__item";
        const label = document.createElement("span");
        const answerLabel = isRecord(answer.legend) && typeof answer.legend[key] === "string" ? answer.legend[key] as string : key;
        label.textContent = view.labels?.[key] ?? answerLabel;
        const meter = document.createElement("progress");
        meter.max = 1;
        meter.value = Math.min(1, Math.max(0, probability));
        meter.setAttribute("aria-label", `${label.textContent}: ${formatProbability(probability)}`);
        const percent = document.createElement("span");
        percent.className = "jev-probabilities__value";
        percent.textContent = formatProbability(probability);
        row.appendChild(label);
        row.appendChild(meter);
        row.appendChild(percent);
        list.appendChild(row);
      }
      card.appendChild(list);
    }

    const confidence = answer?.confidence;
    const confidenceNode = document.createElement("p");
    confidenceNode.className = "jev-answer__confidence";
    confidenceNode.textContent = typeof confidence === "number" ? `Confidence: ${formatProbability(confidence)}` : "Confidence: not provided";
    card.appendChild(confidenceNode);
    fragment.appendChild(card);
  }

  const model = document.createElement("p");
  model.className = "meta";
  model.textContent = `Model: ${result.model}`;
  fragment.appendChild(model);
  target.replaceChildren(fragment);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatProbability(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}
