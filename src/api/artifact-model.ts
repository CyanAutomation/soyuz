export const MAX_ARTIFACTS_PER_RUN = 100;

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
  };
}
