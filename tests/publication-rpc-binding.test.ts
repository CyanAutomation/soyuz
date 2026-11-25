import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { KirisameErrorSchema } from "../src/publication/rpc-v1";

describe("Kirisame publisher service binding", () => {
  it("does not expose the removed receiver-side repository allowlist error", () => {
    expect(KirisameErrorSchema.safeParse({
      code: "REPOSITORY_NOT_ALLOWED",
      classification: "policy",
      message: "The requested repository is not allowed.",
    }).success).toBe(false);
  });

  it("exposes the configured PublisherEntrypoint RPC method", async () => {
    const requestJson = '{"contractVersion":"1"}';
    const callerId = "soyuz";
    const apiKey = "A".repeat(43);
    const publisher = env.KIRISAME! as unknown as {
      publish(requestJson: string, callerId: string, apiKey: string): Promise<unknown>;
    };

    const result = await publisher.publish(requestJson, callerId, apiKey);

    expect(result).toBe(JSON.stringify({ requestJson, callerId, apiKey }));
  });
});
