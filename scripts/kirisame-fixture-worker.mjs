export class PublisherEntrypoint {
  constructor(_ctx, _env) {}

  async publish() {
    return Response.json({ error: { code: "PUBLISHING_UNAVAILABLE" } }, { status: 503 });
  }
}

export default {
  async fetch() {
    return Response.json({ error: { code: "PUBLISHING_UNAVAILABLE" } }, { status: 503 });
  },
};
