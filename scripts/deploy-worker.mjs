import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatWorkerDeploymentMessage, readWorkerProvenance } from "./worker-provenance.mjs";

const provenancePath = resolve(".wrangler/deploy/provenance.json");

export async function deployWorker() {
  const provenance = await readWorkerProvenance(provenancePath);
  const result = spawnSync("wrangler", buildDeployArgs(provenance), { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

export function buildDeployArgs(provenance) {
  return ["deploy", "--keep-vars", "--message", formatWorkerDeploymentMessage(provenance)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deployWorker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
