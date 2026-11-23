import { JEV_PROFILE_VIEWS, type JevProfileId } from "./jev-renderer.js";
import { createCard, createMetricGrid } from "./ui/components.js";

export interface JevFeedbackSummary {
  profiles: Array<{
    profileId: JevProfileId;
    helpfulCount: number;
    notHelpfulCount: number;
    totalCount: number;
  }>;
}

/** Reusable profile-by-profile summary of retained usefulness ratings. */
export function createJevFeedbackOverviewCard(
  summary: JevFeedbackSummary,
  ownerDocument: Document = document,
  available = true,
): HTMLElement {
  const { element, header, body } = createCard({ className: "jev-feedback-overview" }, ownerDocument);
  const title = ownerDocument.createElement("h2");
  title.className = "card__title";
  title.textContent = "JEV usefulness feedback";
  header.appendChild(title);

  if (!available) {
    const unavailable = ownerDocument.createElement("p");
    unavailable.className = "notice notice--warning";
    unavailable.textContent = "JEV feedback summary is currently unavailable.";
    body.appendChild(unavailable);
    return element;
  }

  const profiles = summary.profiles.filter((profile) => JEV_PROFILE_VIEWS[profile.profileId]);
  const total = profiles.reduce((sum, profile) => sum + safeCount(profile.totalCount), 0);
  if (total === 0) {
    const empty = ownerDocument.createElement("p");
    empty.className = "notice notice--empty";
    empty.textContent = "No JEV ratings have been recorded in the retained run window.";
    body.appendChild(empty);
    return element;
  }

  for (const profile of profiles) {
    const section = ownerDocument.createElement("section");
    section.className = "jev-feedback-overview__profile";
    const heading = ownerDocument.createElement("h3");
    heading.textContent = JEV_PROFILE_VIEWS[profile.profileId].title;
    section.appendChild(heading);
    section.appendChild(createMetricGrid([
      { label: "Helpful ratings", value: String(safeCount(profile.helpfulCount)) },
      { label: "Not helpful", value: String(safeCount(profile.notHelpfulCount)) },
      { label: "Total ratings", value: String(safeCount(profile.totalCount)) },
    ], "jev-feedback-overview__metrics", ownerDocument));
    body.appendChild(section);
  }
  return element;
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
