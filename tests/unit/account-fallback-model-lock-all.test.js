// Regression: an expired per-model lock must not mask a still-active
// account-wide lock (`modelLock___all`). isModelLockActive used
// `connection[key] || connection[MODEL_LOCK_ALL]`, so a past per-model expiry
// short-circuited the account-wide read and a locked account was re-selected.
import { describe, expect, it } from "vitest";
import {
  MODEL_LOCK_ALL,
  getModelLockKey,
  isModelLockActive,
} from "../../open-sse/services/accountFallback.js";

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

describe("isModelLockActive — per-model and account-wide locks are independent", () => {
  it("an expired per-model lock does not hide an active account-wide lock", () => {
    const connection = {
      [getModelLockKey("m1")]: past(),
      [MODEL_LOCK_ALL]: future(),
    };
    expect(isModelLockActive(connection, "m1")).toBe(true);
  });

  it("an active per-model lock still locks without an account-wide lock", () => {
    expect(isModelLockActive({ [getModelLockKey("m1")]: future() }, "m1")).toBe(true);
  });

  it("an expired account-wide lock alone does not lock", () => {
    expect(isModelLockActive({ [MODEL_LOCK_ALL]: past() }, "m1")).toBe(false);
  });

  it("both locks expired → not locked", () => {
    const connection = {
      [getModelLockKey("m1")]: past(),
      [MODEL_LOCK_ALL]: past(),
    };
    expect(isModelLockActive(connection, "m1")).toBe(false);
  });

  it("model=null reads the account-wide lock", () => {
    expect(isModelLockActive({ [MODEL_LOCK_ALL]: future() }, null)).toBe(true);
    expect(isModelLockActive({ [MODEL_LOCK_ALL]: past() }, null)).toBe(false);
  });

  it("another model's active lock does not lock this model", () => {
    expect(isModelLockActive({ [getModelLockKey("m2")]: future() }, "m1")).toBe(false);
  });
});
