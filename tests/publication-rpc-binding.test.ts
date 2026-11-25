import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Kirisame publisher service binding", () => {
  it("exposes the configured PublisherEntrypoint RPC method", async () => {
    const requestJson = '{"contractVersion":"1"}';

    const result = await env.KIRISAME!.publish(requestJson);

    expect(JSON.parse(result as string)).toEqual({ requestJson });
  });
});
