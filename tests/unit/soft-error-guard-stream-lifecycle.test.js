import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SOFT_ERROR_GUARD } from "../../open-sse/config/softErrorConfig.js";
import { createSoftErrorContinuePolicy, inspectSoftError } from "../../open-sse/services/softErrorGuard.js";

let previousDisableValue;

beforeEach(() => {
  previousDisableValue = process.env[SOFT_ERROR_GUARD.disableEnv];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (previousDisableValue === undefined) delete process.env[SOFT_ERROR_GUARD.disableEnv];
  else process.env[SOFT_ERROR_GUARD.disableEnv] = previousDisableValue;
});

function responseWithReader(reader) {
  const response = new Response("data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
  vi.spyOn(response, "clone").mockReturnValue({ body: { getReader: () => reader } });
  return response;
}

it("times out a stalled clone, cancels it without awaiting tee cancellation, and keeps the original readable", async () => {
  vi.useFakeTimers();
  const reader = {
    read: vi.fn(() => new Promise(() => {})),
    cancel: vi.fn(() => new Promise(() => {})),
  };
  const response = responseWithReader(reader);
  const pending = inspectSoftError(response);
  await vi.advanceTimersByTimeAsync(SOFT_ERROR_GUARD.peekMaxMs + 1);
  expect(await pending).toBeNull();
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(await response.text()).toBe("data: [DONE]\n\n");
});

it("fails open on read rejection and still cancels the clone", async () => {
  const reader = {
    read: vi.fn().mockRejectedValue(new Error("offline read failure")),
    cancel: vi.fn().mockResolvedValue(),
  };
  const response = responseWithReader(reader);
  expect(await inspectSoftError(response)).toBeNull();
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(await response.text()).toContain("[DONE]");
});

it("releases a stream when the peek reaches its byte limit", async () => {
  const reader = {
    read: vi.fn().mockResolvedValue({
      done: false,
      value: new Uint8Array(SOFT_ERROR_GUARD.peekMaxBytes),
    }),
    cancel: vi.fn().mockResolvedValue(),
  };
  const response = responseWithReader(reader);
  expect(await inspectSoftError(response)).toBeNull();
  expect(reader.read).toHaveBeenCalledTimes(1);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
});

it("checks the kill-switch on each policy call without reading the response when disabled", async () => {
  const policy = createSoftErrorContinuePolicy();
  const reader = { read: vi.fn(), cancel: vi.fn().mockResolvedValue() };
  const response = responseWithReader(reader);
  process.env[SOFT_ERROR_GUARD.disableEnv] = "off";
  expect(await policy(response, { modelStr: "Hb/primary" })).toBe(false);
  expect(reader.read).not.toHaveBeenCalled();
});
