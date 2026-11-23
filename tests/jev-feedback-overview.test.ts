import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { createJevFeedbackOverviewCard, type JevFeedbackSummary } from "../dashboard/jev-feedback-overview";

describe("JEV feedback overview component", () => {
  it("[JEV-FEEDBACK-SUMMARY-01] renders profile-level helpfulness counts without user or answer data", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const summary: JevFeedbackSummary = {
      profiles: [
        { profileId: "run_operations_triage_v1", helpfulCount: 4, notHelpfulCount: 1, totalCount: 5 },
        { profileId: "run_retry_review_v1", helpfulCount: 2, notHelpfulCount: 0, totalCount: 2 },
      ],
    };
    const card = createJevFeedbackOverviewCard(summary, document);

    expect(card.querySelector("h2")?.textContent).toBe("JEV usefulness feedback");
    expect(card.textContent).toContain("Run operations triage");
    expect(card.textContent).toContain("Run retry comparison");
    expect(card.textContent).toContain("Helpful ratings2");
    expect(card.textContent).not.toContain("answers");
    expect(card.textContent).not.toContain("githubUserId");
  });

  it("shows a clear unavailable or empty state", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const card = createJevFeedbackOverviewCard({ profiles: [] }, document);
    expect(card.textContent).toContain("No JEV ratings have been recorded in the retained run window.");
  });
});
