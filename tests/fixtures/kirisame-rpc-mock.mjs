import { WorkerEntrypoint } from "cloudflare:workers";

// fallow-ignore-next-line unused-export -- loaded as a WorkerEntrypoint via vitest.config.ts scriptPath
export class PublisherEntrypoint extends WorkerEntrypoint {
  async publish(requestJson, callerId, apiKey) {
    return JSON.stringify({ requestJson, callerId, apiKey });
  }
}

// fallow-ignore-next-line unused-export -- loaded as a test Worker via vitest.config.ts scriptPath
export default {
  fetch() {
    return new Response("Kirisame RPC mock");
  },
};
