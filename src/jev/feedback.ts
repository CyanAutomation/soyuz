import { ApiError, errorResponse, parseJsonBody, requestIdFor, successResponse } from "../api/http";
import type { Env } from "../env";
import { readRun, RunApplicationError } from "../application/runs";
import { JEV_PROFILE_IDS, JevProfileIdSchema } from "./profile-ids";
import { z } from "zod";

const FeedbackRequestSchema = z.object({
  profileId: JevProfileIdSchema,
  runId: z.string().uuid(),
  rating: z.enum(["helpful", "not_helpful"]),
}).strict();

export async function handleJevFeedbackRequest(
  request: Request,
  env: Env,
  githubUserId: string,
  requestId = requestIdFor(request),
): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request, requestId);
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse(requestId);
    return errorResponse(requestId, 400, "INVALID_REQUEST", "JEV feedback is invalid.");
  }
  const parsed = FeedbackRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(requestId, 400, "INVALID_REQUEST", "Feedback must include a supported profile, run UUID, and rating.");

  try {
    await readRun(env, parsed.data.runId);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO jev_feedback (run_id, profile_id, github_user_id, rating, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, profile_id, github_user_id)
      DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at
    `).bind(parsed.data.runId, parsed.data.profileId, githubUserId, parsed.data.rating, now, now).run();
    return successResponse(requestId, { saved: true });
  } catch (error) {
    if (error instanceof RunApplicationError) {
      return errorResponse(requestId, error.status, error.code, error.publicMessage, { details: error.details });
    }
    return errorResponse(requestId, 503, "JEV_FEEDBACK_UNAVAILABLE", "JEV feedback could not be saved. Retry shortly.");
  }
}

/** Return only aggregate ratings; individual identities and freeform model answers are never selected. */
export async function handleJevFeedbackSummaryRequest(env: Env, requestId: string): Promise<Response> {
  try {
    const rows = await env.DB.prepare(`
      SELECT profile_id, rating, COUNT(*) AS rating_count
      FROM jev_feedback
      GROUP BY profile_id, rating
    `).all<{ profile_id: string; rating: string; rating_count: number }>();
    const counts = new Map<string, { helpfulCount: number; notHelpfulCount: number }>();
    for (const profileId of JEV_PROFILE_IDS) counts.set(profileId, { helpfulCount: 0, notHelpfulCount: 0 });
    for (const row of rows.results ?? []) {
      const entry = counts.get(row.profile_id);
      if (!entry || !Number.isSafeInteger(row.rating_count) || row.rating_count < 0) continue;
      if (row.rating === "helpful") entry.helpfulCount = row.rating_count;
      if (row.rating === "not_helpful") entry.notHelpfulCount = row.rating_count;
    }
    return successResponse(requestId, {
      profiles: JEV_PROFILE_IDS.map((profileId) => {
        const entry = counts.get(profileId)!;
        return { profileId, ...entry, totalCount: entry.helpfulCount + entry.notHelpfulCount };
      }),
    });
  } catch {
    return errorResponse(requestId, 503, "JEV_FEEDBACK_UNAVAILABLE", "JEV feedback summary is unavailable. Retry shortly.");
  }
}
