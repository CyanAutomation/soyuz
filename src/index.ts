import { getSoyuzOAuthProvider } from "./auth/oauth";
import { purgeExpiredArtifacts } from "./api/artifacts";
import { purgeExpiredPublicationManifests, purgeExpiredRunRequests, purgeOldRuns } from "./api/retention";
import type { Env } from "./env";
import { reconcileAdmissions, reconcileStalledRuns } from "./queue/reconcile";
import { reconcilePublications } from "./publication/lifecycle";
import { handleRequest } from "./request-routing";

export { handleRequest };

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, context);
  },
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): void {
    const work = [
      reconcileAdmissions(env),
      reconcileStalledRuns(env),
      reconcilePublications(env).then(() => undefined),
      purgeOldRuns(env).then(() => undefined),
    ];
    if (controller.cron === "0 3 * * *") {
      work.push(purgeExpiredArtifacts(env));
      work.push(purgeExpiredPublicationManifests(env).then(() => undefined));
      work.push(purgeExpiredRunRequests(env).then(() => undefined));
      const provider = getSoyuzOAuthProvider(env);
      if (provider && env.OAUTH_KV) work.push(purgeOAuthData(provider, env));
    }
    context.waitUntil(Promise.all(work).then(() => undefined));
  },
};

async function purgeOAuthData(provider: NonNullable<ReturnType<typeof getSoyuzOAuthProvider>>, env: Env): Promise<void> {
  if (!env.OAUTH_KV) return;
  const cursor = await env.OAUTH_KV.get("soyuz-oauth-purge-cursor");
  const result = await provider.purgeExpiredData(env, { batchSize: 100, cursor: cursor ?? undefined });
  if (result.cursor) await env.OAUTH_KV.put("soyuz-oauth-purge-cursor", result.cursor);
  else await env.OAUTH_KV.delete("soyuz-oauth-purge-cursor");
}
