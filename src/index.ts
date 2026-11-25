import { getSoyuzOAuthProvider } from "./auth/oauth";
import { purgeExpiredArtifacts } from "./api/artifacts";
import { reconcileArtifactStorage } from "./api/artifact-reconciliation";
import { purgeOldRuns } from "./api/retention";
import type { Env } from "./env";
import { reconcileAdmissions, reconcileStalledRuns } from "./queue/reconcile";
import { reconcilePublications } from "./publication/lifecycle";
import { handleRequest } from "./request-routing";
import { purgeOAuthData, scheduleWorkerMaintenance } from "./scheduled";

export { handleRequest };

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, context);
  },
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): void {
    scheduleWorkerMaintenance(controller, env, context, {
      reconcileAdmissions,
      reconcileStalledRuns,
      reconcilePublications,
      purgeOldRuns,
      purgeExpiredArtifacts,
      reconcileArtifactStorage,
      getOAuthProvider: getSoyuzOAuthProvider,
      purgeOAuthData,
    });
  },
};
