import { parseEventPayload, type RunEventRow } from "../db/runs";

export function publicEvent(row: RunEventRow): Record<string, unknown> {
  return {
    contractVersion: row.contract_version,
    runId: row.run_id,
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.type,
    workerId: row.worker_id,
    stage: row.stage,
    step: row.step,
    timestamp: row.occurred_at,
    recordedAt: row.recorded_at,
    payload: parseEventPayload(row),
  };
}
