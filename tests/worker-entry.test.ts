import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { purgeOAuthData, scheduleWorkerMaintenance, type OAuthProvider, type ScheduledJobs } from "../src/scheduled";

function createJobs(provider: OAuthProvider | null = null): ScheduledJobs {
  return {
    reconcileAdmissions: vi.fn(async () => undefined),
    reconcileStalledRuns: vi.fn(async () => undefined),
    reconcilePublications: vi.fn(async () => undefined),
    purgeOldRuns: vi.fn(async () => undefined),
    purgeExpiredArtifacts: vi.fn(async () => undefined),
    purgeExpiredPublicationManifests: vi.fn(async () => undefined),
    purgeExpiredRunRequests: vi.fn(async () => undefined),
    getOAuthProvider: vi.fn(() => provider),
    purgeOAuthData: vi.fn(async () => undefined),
  };
}

function runSchedule(cron: string, env: Env, jobs: ScheduledJobs): Promise<void> {
  const pending: Promise<unknown>[] = [];
  scheduleWorkerMaintenance(
    { cron } as ScheduledController,
    env,
    { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext,
    jobs,
  );
  return Promise.all(pending).then(() => undefined);
}

describe("Worker scheduled entry point", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs admission, liveness, and publication reconciliation on the regular schedule", async () => {
    const env = {} as Env;
    const jobs = createJobs();

    await runSchedule("*/5 * * * *", env, jobs);

    expect(jobs.reconcileAdmissions).toHaveBeenCalledWith(env);
    expect(jobs.reconcileStalledRuns).toHaveBeenCalledWith(env);
    expect(jobs.reconcilePublications).toHaveBeenCalledWith(env);
    expect(jobs.purgeOldRuns).toHaveBeenCalledWith(env);
    expect(jobs.purgeExpiredArtifacts).not.toHaveBeenCalled();
    expect(jobs.getOAuthProvider).not.toHaveBeenCalled();
  });

  it("runs daily retention and sends OAuth cleanup to the cursor-aware purger", async () => {
    const provider = {} as OAuthProvider;
    const env = { OAUTH_KV: {} } as unknown as Env;
    const jobs = createJobs(provider);

    await runSchedule("0 3 * * *", env, jobs);

    expect(jobs.purgeExpiredArtifacts).toHaveBeenCalledWith(env);
    expect(jobs.purgeExpiredPublicationManifests).toHaveBeenCalledWith(env);
    expect(jobs.purgeExpiredRunRequests).toHaveBeenCalledWith(env);
    expect(jobs.getOAuthProvider).toHaveBeenCalledWith(env);
    expect(jobs.purgeOAuthData).toHaveBeenCalledWith(provider, env);
  });

  it("stores a continuation cursor and clears it when OAuth cleanup completes", async () => {
    const provider = {
      purgeExpiredData: vi.fn()
        .mockResolvedValueOnce({ cursor: "next-page" })
        .mockResolvedValueOnce({}),
    } as unknown as OAuthProvider;
    const oauthKv = {
      get: vi.fn().mockResolvedValueOnce("previous-page").mockResolvedValueOnce(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const env = { OAUTH_KV: oauthKv } as unknown as Env;

    await purgeOAuthData(provider, env);
    await purgeOAuthData(provider, env);

    expect(provider.purgeExpiredData).toHaveBeenNthCalledWith(1, env, { batchSize: 100, cursor: "previous-page" });
    expect(provider.purgeExpiredData).toHaveBeenNthCalledWith(2, env, { batchSize: 100, cursor: undefined });
    expect(oauthKv.put).toHaveBeenCalledWith("soyuz-oauth-purge-cursor", "next-page");
    expect(oauthKv.delete).toHaveBeenCalledWith("soyuz-oauth-purge-cursor");
  });
});
