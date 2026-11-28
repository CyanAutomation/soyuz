import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDeployArgs } from "./deploy-worker.mjs";
import {
  createWorkerProvenance,
  formatWorkerDeploymentMessage,
  readWorkerProvenance,
  selectWorkerSourceSha,
  validateWorkerProvenance,
  writeWorkerProvenance,
} from "./worker-provenance.mjs";

const SOURCE_SHA = "a".repeat(40);

test("worker provenance records the source, app, contract, and build timestamp", async () => {
  const provenance = await createWorkerProvenance({
    sourceSha: SOURCE_SHA,
    builtAt: "2026-11-28T12:00:00.000Z",
  });

  assert.deepEqual(provenance, {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    appVersion: "0.1.0",
    contractVersion: "1",
    builtAt: "2026-11-28T12:00:00.000Z",
  });
  assert.equal(
    formatWorkerDeploymentMessage(provenance),
    `sha=${SOURCE_SHA},v=0.1.0,c=1,ts=2026-11-28T12:00:00.000Z`,
  );
  assert.deepEqual(buildDeployArgs(provenance), [
    "deploy", "--keep-vars", "--message", `sha=${SOURCE_SHA},v=0.1.0,c=1,ts=2026-11-28T12:00:00.000Z`,
  ]);
});

test("worker provenance rejects malformed source and timestamp fields", async () => {
  await assert.rejects(createWorkerProvenance({ sourceSha: "main", builtAt: "2026-11-28" }), /provenance/);
  assert.throws(() => validateWorkerProvenance({ schemaVersion: 1, sourceSha: SOURCE_SHA }), /provenance/);
  assert.throws(() => formatWorkerDeploymentMessage({
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    appVersion: "0.1.0",
    contractVersion: "1",
    builtAt: "not-a-time",
  }), /provenance/);
});

test("worker source provenance matches HEAD and requires clean local checkouts", () => {
  assert.equal(selectWorkerSourceSha({ checkoutSha: SOURCE_SHA, isCi: false, isClean: true }), SOURCE_SHA);
  assert.equal(selectWorkerSourceSha({ providedSha: SOURCE_SHA, checkoutSha: SOURCE_SHA, isCi: true, isClean: false }), SOURCE_SHA);
  assert.throws(() => selectWorkerSourceSha({
    providedSha: "b".repeat(40), checkoutSha: SOURCE_SHA, isCi: true, isClean: true,
  }), /does not match/);
  assert.throws(() => selectWorkerSourceSha({ checkoutSha: SOURCE_SHA, isCi: false, isClean: false }), /clean local checkout/);
});

test("worker provenance round-trips through the bundle metadata file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "soyuz-worker-provenance-"));
  const filename = path.join(directory, "provenance.json");
  try {
    const written = await writeWorkerProvenance(filename, {
      sourceSha: SOURCE_SHA,
      builtAt: "2026-11-28T12:00:00.000Z",
    });
    assert.deepEqual(await readWorkerProvenance(filename), written);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

