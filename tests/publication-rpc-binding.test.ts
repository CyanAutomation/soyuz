import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Kirisame publisher service binding", () => {
  it("exposes the configured PublisherEntrypoint RPC method", async () => {
    const requestJson = '{"contractVersion":"1"}';
    const publisher = env.KIRISAME! as unknown as {
      publish(requestJson: string): Promise<unknown>;
    };

    const result = await publisher.publish(requestJson);

    expect(result).toBe(JSON.stringify({ requestJson }));
  });
});
