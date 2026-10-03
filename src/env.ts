export interface Env {
  DB: D1Database;
  RUN_QUEUE: Queue;
  CLIENT_API_TOKEN: string;
  WORKER_API_TOKEN: string;
}
