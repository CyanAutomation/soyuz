import { WorkerEntrypoint } from "cloudflare:workers";

export class PublisherEntrypoint extends WorkerEntrypoint {
  async publish(requestJson) {
    return JSON.stringify({ requestJson });
  }
}

export default {
  fetch() {
    return new Response("Kirisame RPC mock");
  },
};
