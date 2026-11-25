import type { Env } from "./env";
import type { getSoyuzOAuthProvider } from "./auth/oauth";

export type OAuthProvider = NonNullable<ReturnType<typeof getSoyuzOAuthProvider>>;

export interface ScheduledJobs {
  reconcileAdmissions(env: Env): Promise<unknown>;
  reconcileStalledRuns(env: Env): Promise<unknown>;
  reconcilePublications(env: Env): Promise<unknown>;
  purgeOldRuns(env: Env): Promise<unknown>;
  purgeExpiredArtifacts(env: Env): Promise<unknown>;
  reconcileArtifactStorage(env: Env): Promise<unknown>;
  getOAuthProvider(env: Env): OAuthProvider | null;
  purgeOAuthData(provider: OAuthProvider, env: Env): Promise<unknown>;
}

export function scheduleWorkerMaintenance(
  controller: ScheduledController,
  env: Env,
  context: ExecutionContext,
  jobs: ScheduledJobs,
): void {
  const work: Promise<unknown>[] = [
    jobs.reconcileAdmissions(env),
    jobs.reconcileStalledRuns(env),
    jobs.reconcilePublications(env),
    jobs.purgeOldRuns(env),
    jobs.purgeExpiredArtifacts(env),
    jobs.reconcileArtifactStorage(env),
  ];
  if (controller.cron === "0 3 * * *") {
    const provider = jobs.getOAuthProvider(env);
    if (provider && env.OAUTH_KV) work.push(jobs.purgeOAuthData(provider, env));
  }
  context.waitUntil(Promise.all(work).then(() => undefined));
}

export async function purgeOAuthData(provider: OAuthProvider, env: Env): Promise<void> {
  if (!env.OAUTH_KV) return;
  const cursor = await env.OAUTH_KV.get("soyuz-oauth-purge-cursor");
  const result = await provider.purgeExpiredData(env, { batchSize: 100, cursor: cursor ?? undefined });
  if (result.cursor) await env.OAUTH_KV.put("soyuz-oauth-purge-cursor", result.cursor);
  else await env.OAUTH_KV.delete("soyuz-oauth-purge-cursor");
}
