import { createActionButton, createBadge, createCard, setButtonBusy, setNotice, type NoticeTone } from "./ui/components.js";
import { JEV_PROFILE_VIEWS, renderJevResult, type JevProfileId } from "./jev-renderer.js";

export type JevRating = "helpful" | "not_helpful";
export type JevResult = { model: string; answers: Record<string, unknown> };

export interface JevAssessmentState {
  profileId?: JevProfileId;
  status: "idle" | "loading" | "error" | "complete";
  message?: string;
  result?: JevResult;
  rating?: JevRating | null;
  feedbackBusy?: boolean;
  feedbackMessage?: string;
}

export interface JevAssessmentPanelOptions {
  runId: string;
  profileId: JevProfileId;
  state: JevAssessmentState;
  onAssess: (runId: string, profileId: JevProfileId) => void;
  onFeedback: (rating: JevRating) => void;
  ownerDocument?: Document;
}

/** Reusable, explicit JEV advisory controls for a run card. */
export function createJevAssessmentPanel(options: JevAssessmentPanelOptions): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  const profile = JEV_PROFILE_VIEWS[options.profileId];
  const { element, header, body } = createCard({ tagName: "section", className: "jev-panel" }, ownerDocument);
  element.setAttribute("aria-label", "Decision support with JEV");

  const title = ownerDocument.createElement("h3");
  title.className = "card__title";
  title.textContent = "Decision support with JEV";
  header.appendChild(title);
  header.appendChild(createBadge(`Suggested: ${profile.title}`, "active", ownerDocument));

  const explanation = ownerDocument.createElement("p");
  explanation.className = "jev-panel__description";
  explanation.textContent = "Run an explicit advisory assessment using Soyuz's bounded run projection. JEV does not change the run or publication.";
  const assess = createActionButton("Assess with JEV", () => options.onAssess(options.runId, options.profileId), {
    variant: "secondary",
    className: "jev-panel__assess",
    disabled: options.state.status === "loading",
    ownerDocument,
  });
  setButtonBusy(assess, options.state.status === "loading", "Assessing run…");

  const notice = ownerDocument.createElement("p");
  notice.className = "notice";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  const noticeTone: NoticeTone = options.state.status === "error" ? "warning" : "info";
  const noticeText = options.state.status === "loading"
    ? "Sending the approved run projection to Senku for advisory analysis…"
    : options.state.status === "complete"
      ? options.state.message ?? "Advisory result received. Verify the run record before taking consequential action."
      : options.state.status === "error"
        ? options.state.message ?? "JEV could not validate a response for this run. No action was taken."
        : "This assessment runs only when you choose it.";
  setNotice(notice, noticeText, noticeTone);

  const output = ownerDocument.createElement("div");
  output.className = "jev-panel__output";
  output.setAttribute("aria-label", "JEV advisory decision results");
  output.hidden = options.state.status !== "complete" || !options.state.result;
  if (options.state.result) renderJevResult(output, options.profileId, options.state.result);

  const feedback = ownerDocument.createElement("div");
  feedback.className = "jev-panel__feedback";
  feedback.setAttribute("aria-label", "JEV assessment feedback");
  feedback.hidden = options.state.status !== "complete" || !options.state.result;
  const feedbackPrompt = ownerDocument.createElement("p");
  feedbackPrompt.textContent = "Was this assessment useful?";
  const helpful = createActionButton("Helpful", () => options.onFeedback("helpful"), {
    disabled: Boolean(options.state.feedbackBusy) || options.state.rating === "helpful",
    ownerDocument,
  });
  const notHelpful = createActionButton("Not helpful", () => options.onFeedback("not_helpful"), {
    disabled: Boolean(options.state.feedbackBusy) || options.state.rating === "not_helpful",
    ownerDocument,
  });
  const feedbackNotice = ownerDocument.createElement("p");
  feedbackNotice.className = "meta jev-panel__feedback-notice";
  feedbackNotice.setAttribute("role", "status");
  feedbackNotice.setAttribute("aria-live", "polite");
  feedbackNotice.textContent = options.state.feedbackMessage ?? "";
  if (options.state.feedbackBusy) {
    setButtonBusy(helpful, true, "Saving rating…");
    notHelpful.disabled = true;
  }
  if (options.state.rating === "helpful") helpful.setAttribute("aria-pressed", "true");
  if (options.state.rating === "not_helpful") notHelpful.setAttribute("aria-pressed", "true");
  feedback.appendChild(feedbackPrompt);
  feedback.appendChild(helpful);
  feedback.appendChild(notHelpful);
  feedback.appendChild(feedbackNotice);

  body.appendChild(explanation);
  body.appendChild(assess);
  body.appendChild(notice);
  body.appendChild(output);
  body.appendChild(feedback);
  return element;
}
