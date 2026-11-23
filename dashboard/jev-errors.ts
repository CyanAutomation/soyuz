import { HttpError } from "./api.js";

export const defaultJevFailureMessage = "JEV assessment failed. No action was taken.";

const JEV_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  JEV_PROVIDER_UNAVAILABLE: "JEV could not reach its decision service. Retry shortly. No action was taken.",
  JEV_PROVIDER_TIMEOUT: "JEV analysis timed out. Retry shortly. No action was taken.",
  JEV_RESPONSE_INVALID: "JEV returned a response that Soyuz could not validate. No action was taken.",
  JEV_UNAVAILABLE: "JEV is not configured for this dashboard. Contact your Soyuz administrator.",
  JEV_CONTEXT_UNAVAILABLE: "Soyuz could not prepare the run data for JEV. No action was taken.",
  JEV_REQUEST_INVALID: "Soyuz could not prepare a valid JEV request. No action was taken.",
  JEV_PROFILE_NOT_APPLICABLE: "This JEV assessment is not available for this run. No action was taken.",
  RUN_NOT_FOUND: "This run is no longer available for JEV assessment. No action was taken.",
});

/** Maps API failures to user-facing copy without displaying arbitrary server text. */
export function jevAssessmentErrorMessage(error: unknown): string {
  if (!(error instanceof HttpError)) return defaultJevFailureMessage;
  if (error.status === 429) return "The JEV request limit was reached. Wait a minute before trying again.";

  const message = error.code ? JEV_ERROR_MESSAGES[error.code] : undefined;
  if (!message) return defaultJevFailureMessage;
  const requestId = error.requestId && /^[a-zA-Z0-9-]{1,128}$/.test(error.requestId) ? error.requestId : undefined;
  return requestId ? `${message} Reference: ${requestId}.` : message;
}
