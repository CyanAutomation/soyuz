import { expect, it, vi } from "vitest";
import { handleRequest, KIRISAME_API_TEST_KEY, SOYUZ_OPERATOR_API_TEST_TOKEN, testEnv } from "../support/api-test-helpers";

const PREFLIGHT_URL = "https://soyuz.test/v1/operator/kirisame/preflight";

it("requires the separate operator token and never invokes publication", async () => {
  const { bindings } = testEnv();
  const verifyCanaryAuthorization = vi.fn(async () => ({ status: "verified", repository: "CyanAutomation/somatic" }));
  const publish = vi.fn(async () => ({ outcome: "published" }));
  bindings.SOYUZ_OPERATOR_API_TOKEN = SOYUZ_OPERATOR_API_TEST_TOKEN;
  bindings.KIRISAME = { publish, verifyCanaryAuthorization };

  const missing = await handleRequest(new Request(PREFLIGHT_URL, { method: "POST" }), bindings);
  const incorrect = await handleRequest(new Request(PREFLIGHT_URL, {
    method: "POST", headers: { authorization: "Bearer incorrect-operator-token-value" },
  }), bindings);
  const authorized = await handleRequest(new Request(PREFLIGHT_URL, {
    method: "POST", headers: { authorization: `Bearer ${SOYUZ_OPERATOR_API_TEST_TOKEN}` },
  }), bindings);

  expect(missing.status).toBe(401);
  expect(incorrect.status).toBe(401);
  expect(authorized.status).toBe(200);
  const authorizedBody = await authorized.text();
  expect(JSON.parse(authorizedBody)).toMatchObject({ status: "verified", repository: "CyanAutomation/somatic" });
  expect(verifyCanaryAuthorization).toHaveBeenCalledWith("soyuz", KIRISAME_API_TEST_KEY);
  expect(publish).not.toHaveBeenCalled();
  expect(authorizedBody).not.toContain(KIRISAME_API_TEST_KEY);
});

it("returns only sanitized failure details and fails closed without the private binding", async () => {
  const { bindings } = testEnv();
  const verifyCanaryAuthorization = vi.fn(async () => ({
    status: "rejected", code: "UNAUTHORIZED_CALLER", failureStage: "caller_authentication",
    message: "Do not expose this message or secret.", apiKey: KIRISAME_API_TEST_KEY,
  }));
  bindings.SOYUZ_OPERATOR_API_TOKEN = SOYUZ_OPERATOR_API_TEST_TOKEN;
  bindings.KIRISAME = { publish: vi.fn(async () => ({})), verifyCanaryAuthorization };
  const headers = { authorization: `Bearer ${SOYUZ_OPERATOR_API_TEST_TOKEN}` };

  const rejected = await handleRequest(new Request(PREFLIGHT_URL, { method: "POST", headers }), bindings);
  bindings.KIRISAME = undefined;
  const unavailable = await handleRequest(new Request(PREFLIGHT_URL, { method: "POST", headers }), bindings);

  expect(rejected.status).toBe(503);
  const rejectedBody = await rejected.text();
  expect(JSON.parse(rejectedBody)).toMatchObject({ status: "rejected", code: "UNAUTHORIZED_CALLER", failureStage: "caller_authentication" });
  expect(rejectedBody).not.toContain(KIRISAME_API_TEST_KEY);
  expect(unavailable.status).toBe(503);
  expect(verifyCanaryAuthorization).toHaveBeenCalledTimes(1);
});

it.each(["WORKER_API_TOKEN", "KIRISAME_API_KEY", "SENKU_SOYUZ_API_TOKEN"] as const)(
  "rejects an operator token shared with %s", async (credential) => {
  const { bindings } = testEnv();
  const verifyCanaryAuthorization = vi.fn(async () => ({ status: "verified", repository: "CyanAutomation/somatic" }));
  bindings.SOYUZ_OPERATOR_API_TOKEN = bindings[credential]!;
  bindings.KIRISAME = { publish: vi.fn(async () => ({})), verifyCanaryAuthorization };

  const response = await handleRequest(new Request(PREFLIGHT_URL, {
    method: "POST", headers: { authorization: `Bearer ${bindings[credential]}` },
  }), bindings);

  expect(response.status).toBe(503);
  expect(verifyCanaryAuthorization).not.toHaveBeenCalled();
  },
);
