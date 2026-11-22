import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const codeql = await readFile(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
const scorecard = await readFile(new URL("../.github/workflows/scorecard.yml", import.meta.url), "utf8");
const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const deploymentDocs = await readFile(new URL("../docs/DEPLOYMENT.md", import.meta.url), "utf8");

function jobBlock(workflow, name) {
  return workflow
    .split(/(?=^  [\w-]+:\s*$)/m)
    .find((section) => section.startsWith(`  ${name}:`)) ?? "";
}

test("CI runs on pull requests, main pushes, and merge queue candidates", () => {
  assert.match(ci, /^  pull_request:/m);
  assert.match(ci, /^  push:/m);
  assert.match(ci, /^  merge_group:/m);

  const validate = jobBlock(ci, "validate");
  assert.match(jobBlock(ci, "dependency-review"), /if:\s*github\.event_name == 'pull_request'/);
  assert.match(jobBlock(ci, "d1-migration-impact"), /if:\s*github\.event_name == 'pull_request'/);
  assert.match(validate, /if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/);
  assert.match(validate, /github\.event_name == 'pull_request' && \(needs\.dependency-review/);
});

test("all workflow jobs use a fixed Ubuntu runner image", () => {
  for (const [name, workflow] of [["CI", ci], ["CodeQL", codeql], ["Scorecard", scorecard]]) {
    assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-latest/);
    assert.match(workflow, /runs-on:\s*ubuntu-24\.04/, `${name} should pin its runner image`);
  }
});

test("CI reports high-severity dependency advisories and matches Wrangler versions", () => {
  const validate = jobBlock(ci, "validate");
  assert.match(validate, /npm audit --audit-level=high/);
  assert.match(validate, /Report dependency advisories[\s\S]*?continue-on-error:\s*true/);
  const productionAudit = validate.match(/- name: Audit production dependencies[\s\S]*?(?=\n      - name:|\n  [\w-]+:|$)/)?.[0] ?? "";
  assert.match(productionAudit, /npm audit --omit=dev --audit-level=high/);
  assert.doesNotMatch(productionAudit, /continue-on-error/);
  const deployWranglerVersion = ci.match(/wranglerVersion:\s*["']([^"']+)["']/)?.[1];
  assert.equal(deployWranglerVersion, packageLock.packages["node_modules/wrangler"].version);
});

test("dependency and deployment jobs monitor runner egress", () => {
  const validate = jobBlock(ci, "validate");
  assert.match(validate, /steps:\s*\n\s+- name: Monitor runner egress/, "validation should start egress monitoring before every other step");

  for (const [name, job] of [
    ["validate", validate],
    ["production-d1-preflight", jobBlock(ci, "production-d1-preflight")],
    ["deploy", jobBlock(ci, "deploy")],
  ]) {
    assert.match(job, /uses: step-security\/harden-runner@[0-9a-f]{40}/, `${name} should pin harden-runner`);
    assert.match(job, /egress-policy:\s*audit/, `${name} should monitor egress before enforcing an allowlist`);
    assert.ok(job.indexOf("uses: step-security/harden-runner@") < job.indexOf("uses: actions/checkout@"), `${name} should start egress monitoring before checkout`);
  }
});

test("the attested Worker archive includes a CycloneDX SBOM", () => {
  const validate = jobBlock(ci, "validate");
  const sbomStep = validate.match(/- name: Generate dependency SBOM[\s\S]*?(?=\n      - name:|\n  [\w-]+:|$)/)?.[0] ?? "";
  assert.match(sbomStep, /uses: anchore\/sbom-action@[0-9a-f]{40}/);
  assert.match(sbomStep, /file:\s*package-lock\.json/);
  assert.match(sbomStep, /format:\s*cyclonedx-json/);
  assert.match(sbomStep, /output-file:\s*soyuz-sbom\.cdx\.json/);
  assert.match(sbomStep, /upload-artifact:\s*false/);
  assert.match(sbomStep, /if:\s*github\.event_name\s*==\s*'push'/);
  assert.match(validate, /tar -czf[^\n]*soyuz-sbom\.cdx\.json/);
  assert.ok(validate.indexOf("Generate dependency SBOM") < validate.indexOf("tar -czf"), "the SBOM must exist before packaging");

  const attest = jobBlock(ci, "attest");
  assert.match(attest, /subject-path:\s*soyuz-worker-\$\{\{ github\.sha \}\}\.tar\.gz/);
});

test("the deploy artifact is attested after main validation and verified before extraction", () => {
  const validate = jobBlock(ci, "validate");
  const attest = jobBlock(ci, "attest");
  const deploy = jobBlock(ci, "deploy");

  assert.match(validate, /tar -czf/);
  assert.match(validate, /path:\s+soyuz-worker-\$\{\{ github\.sha \}\}\.tar\.gz/);
  assert.match(attest, /needs:\s*validate/);
  assert.match(attest, /id-token:\s*write/);
  assert.match(attest, /attestations:\s*write/);
  assert.match(attest, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.doesNotMatch(validate, /id-token:\s*write/);
  assert.match(deploy, /needs:[\s\S]*attest/);
  assert.ok(deploy.indexOf("gh attestation verify") < deploy.indexOf("tar -xzf"));
  assert.match(deploy, /--signer-workflow "github\.com\/\$GITHUB_REPOSITORY\/\.github\/workflows\/ci\.yml"/);
  assert.match(deploy, /--source-ref "\$GITHUB_REF"/);
});

test("CodeQL scans merge queue candidates", () => {
  assert.match(codeql, /^  merge_group:/m);
});

test("Scorecard publishes SARIF from main and scheduled runs with pinned actions", () => {
  assert.match(scorecard, /^  push:/m);
  assert.match(scorecard, /^  schedule:/m);
  assert.doesNotMatch(scorecard, /^  pull_request:/m);
  assert.match(scorecard, /ossf\/scorecard-action@[0-9a-f]{40}/);
  assert.match(scorecard, /publish_results:\s*true/);
  assert.match(scorecard, /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/);
  assert.match(scorecard, /security-events:\s*write/);
  assert.match(scorecard, /id-token:\s*write/);
});

test("deployment guidance calls out CodeQL as a required analysis check and documents artifact provenance", () => {
  assert.match(deploymentDocs, /Analyze JavaScript and TypeScript/);
  assert.match(deploymentDocs, /attestation|provenance/i);
  assert.match(deploymentDocs, /npm audit/);
  assert.match(deploymentDocs, /secret scanning and push protection/i);
});
