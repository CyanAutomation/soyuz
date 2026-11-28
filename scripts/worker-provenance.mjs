import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenancePath = resolve(projectRoot, ".wrangler/deploy/provenance.json");
const sourceShaPattern = /^[a-f0-9]{40}$/;
const appVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const contractVersionPattern = /^\d+$/;

export async function createWorkerProvenance({ sourceSha, builtAt = new Date().toISOString() } = {}) {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const contracts = await readFile(resolve(projectRoot, "src/publication/contract-v1.ts"), "utf8");
  const contractMatch = contracts.match(/export const PUBLICATION_CONTRACT_VERSION = "(\d+)" as const;/);
  if (!contractMatch) throw new Error("Could not read the publication contract version from src/publication/contract-v1.ts.");

  const resolvedSourceSha = sourceSha ?? await resolveSourceSha();
  const provenance = {
    schemaVersion: 1,
    sourceSha: resolvedSourceSha,
    appVersion: packageJson.version,
    contractVersion: contractMatch[1],
    builtAt,
  };
  return validateWorkerProvenance(provenance);
}

export function validateWorkerProvenance(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || input.schemaVersion !== 1
    || typeof input.sourceSha !== "string" || !sourceShaPattern.test(input.sourceSha)
    || typeof input.appVersion !== "string" || !appVersionPattern.test(input.appVersion)
    || typeof input.contractVersion !== "string" || !contractVersionPattern.test(input.contractVersion)
    || typeof input.builtAt !== "string"
    || !isCanonicalUtcTimestamp(input.builtAt)
    || Object.keys(input).sort().join(",") !== "appVersion,builtAt,contractVersion,schemaVersion,sourceSha") {
    throw new Error("Invalid Worker deployment provenance.");
  }
  return input;
}

export function selectWorkerSourceSha({ providedSha, checkoutSha, isCi, isClean }) {
  if (!sourceShaPattern.test(checkoutSha)) throw new Error("Git checkout has an invalid source SHA.");
  if (providedSha !== undefined && providedSha !== checkoutSha) {
    throw new Error("Worker provenance source SHA does not match the checked-out commit.");
  }
  if (!isCi && !isClean) throw new Error("Worker provenance requires a clean local checkout.");
  return providedSha ?? checkoutSha;
}

export function formatWorkerDeploymentMessage(input) {
  const provenance = validateWorkerProvenance(input);
  if (!isCanonicalUtcTimestamp(provenance.builtAt)) throw new Error("Invalid Worker provenance timestamp.");
  const message = `sha=${provenance.sourceSha},v=${provenance.appVersion},c=${provenance.contractVersion},ts=${provenance.builtAt}`;
  if (message.length > 128 || !/^[A-Za-z0-9.,=:+-]+$/.test(message)) {
    throw new Error("Worker deployment annotation exceeds its safe format.");
  }
  return message;
}

export async function writeWorkerProvenance(outputPath = provenancePath, options = {}) {
  const provenance = await createWorkerProvenance(options);
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

export async function readWorkerProvenance(inputPath = provenancePath) {
  const contents = await readFile(resolve(inputPath), "utf8");
  return validateWorkerProvenance(JSON.parse(contents));
}

async function resolveSourceSha() {
  const provided = process.env.SOURCE_SHA ?? process.env.GITHUB_SHA;
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  return selectWorkerSourceSha({
    providedSha: provided,
    checkoutSha,
    isCi: process.env.GITHUB_ACTIONS === "true",
    isClean: !status.trim(),
  });
}

function isCanonicalUtcTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === "read") {
    const provenance = await readWorkerProvenance(file ?? provenancePath);
    process.stdout.write(`message=${formatWorkerDeploymentMessage(provenance)}\n`);
    return;
  }

  const output = command && command !== "write" ? command : file ?? provenancePath;
  await writeWorkerProvenance(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
