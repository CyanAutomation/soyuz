import { MAX_ARTIFACTS_PER_RUN } from "../persistence/retention-policy";

export { MAX_ARTIFACTS_PER_RUN };

export type ArtifactType =
  | "execution.summary" | "execution.failure" | "execution.log" | "execution.report" | "execution.other"
  | "code.diff" | "code.changed-files" | "code.patch"
  | "validation.result" | "evaluation.scorecard" | "evaluation.result"
  | "decision.evidence" | "telemetry.metrics" | "publication.manifest";

export interface ArtifactRow {
  id: string;
  run_id: string;
  kind: "log" | "patch" | "report" | "other";
  name: string;
  content_type: string;
  size_bytes: number;
  object_key: string;
  created_at: string;
  expires_at: string;
  state: "pending" | "ready";
  artifact_type: ArtifactType;
  artifact_schema_version: number;
  content_encoding: string;
  sha256: string | null;
  producer_id: string;
  engine_id: string;
  engine_version: string | null;
  retention_policy_version: number;
  object_status: "present" | "missing";
}

export function publicArtifact(row: ArtifactRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    size: row.size_bytes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    artifactType: row.artifact_type,
    schemaVersion: row.artifact_schema_version,
    sha256: row.sha256,
    producerId: row.producer_id,
    engineId: row.engine_id,
    engineVersion: row.engine_version,
    available: row.object_status !== "missing",
  };
}
