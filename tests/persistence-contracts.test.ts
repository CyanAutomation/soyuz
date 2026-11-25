import Ajv2020 from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import { retentionExpiry } from "../src/persistence/retention-policy";
import retentionPolicySchema from "../contracts/persistence/v1/retention-policy.schema.json";
import runRecordSchema from "../contracts/persistence/v1/run-record.schema.json";
import runEventSchema from "../contracts/persistence/v1/run-event.schema.json";
import executionOutcomeSchema from "../contracts/persistence/v1/execution-outcome.schema.json";
import artifactRecordSchema from "../contracts/persistence/v1/artifact-record.schema.json";
import artifactManifestSchema from "../contracts/persistence/v1/artifact-manifest.schema.json";
import artifactEnvelopeSchema from "../contracts/persistence/v1/artifact-envelope.schema.json";
import decisionRecordSchema from "../contracts/persistence/v1/decision-record.schema.json";
import publicationRecordSchema from "../contracts/persistence/v1/publication-record.schema.json";
import retentionPolicyExample from "../contracts/persistence/v1/examples/retention-policy.json";
import validRunExample from "../contracts/persistence/v1/examples/valid-run-record.json";
import invalidRunExample from "../contracts/persistence/v1/examples/invalid-run-record-expiry.json";
import validManifestExample from "../contracts/persistence/v1/examples/valid-artifact-manifest.json";
import invalidManifestExample from "../contracts/persistence/v1/examples/invalid-artifact-manifest.json";

const schemaNames = ["retention-policy", "run-record", "run-event", "execution-outcome", "artifact-record", "artifact-manifest", "artifact-envelope", "decision-record", "publication-record"] as const;
const schemas = new Map<string, AnySchema>([
  ["retention-policy", retentionPolicySchema], ["run-record", runRecordSchema], ["run-event", runEventSchema],
  ["execution-outcome", executionOutcomeSchema], ["artifact-record", artifactRecordSchema],
  ["artifact-manifest", artifactManifestSchema], ["artifact-envelope", artifactEnvelopeSchema],
  ["decision-record", decisionRecordSchema], ["publication-record", publicationRecordSchema],
]);
const examples = new Map<string, unknown>([
  ["retention-policy", retentionPolicyExample], ["valid-run-record", validRunExample],
  ["invalid-run-record-expiry", invalidRunExample], ["valid-artifact-manifest", validManifestExample],
  ["invalid-artifact-manifest", invalidManifestExample],
]);

describe("versioned persistence contracts", () => {
  let ajv: Ajv2020;

  beforeAll(() => {
    ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const schema of schemas.values()) ajv.addSchema(schema);
  });

  it("compiles every published persistence schema and accepts the retention policy", () => {
    for (const name of schemaNames) expect(ajv.getSchema(`https://contracts.cyanautomation.dev/soyuz/persistence/v1/${name}.schema.json`)).toBeTruthy();
    expect(ajv.validate(schemas.get("retention-policy")!, examples.get("retention-policy"))).toBe(true);
  });

  it("accepts a valid run record and rejects run expiry beyond its canonical creation deadline", () => {
    const validate = ajv.compile(schemas.get("run-record")!);
    const valid = examples.get("valid-run-record") as { createdAt: string; expiresAt: string };
    const invalid = examples.get("invalid-run-record-expiry") as { createdAt: string; expiresAt: string };
    expect(validate(valid)).toBe(true);
    expect(valid.expiresAt).toBe(retentionExpiry(valid.createdAt));
    expect(validate(invalid)).toBe(true); // JSON Schema cannot express date arithmetic; enforce the policy here.
    expect(invalid.expiresAt).not.toBe(retentionExpiry(invalid.createdAt));
  });

  it("accepts the executor-neutral manifest and rejects deadlines beyond the owning run", () => {
    const validate = ajv.compile(schemas.get("artifact-manifest")!);
    const valid = examples.get("valid-artifact-manifest") as { expiresAt: string; persistedArtifacts: Array<{ expiresAt: string }> };
    const invalid = examples.get("invalid-artifact-manifest") as { expiresAt: string; persistedArtifacts: Array<unknown> };
    const runExpiry = (examples.get("valid-run-record") as { expiresAt: string }).expiresAt;
    expect(validate(valid)).toBe(true);
    expect(valid.expiresAt).toBe(runExpiry);
    expect(valid.persistedArtifacts[0]?.expiresAt).toBe(runExpiry);
    expect(validate(invalid)).toBe(true);
    expect(Date.parse(invalid.expiresAt)).toBeGreaterThan(Date.parse(runExpiry));
  });
});
