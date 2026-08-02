import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { confirmSignature, isRoundNotActive } from "../src/exec/confirm.js";

/** Virtual clock: sleep() advances time instantly. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function mockConn(opts: {
  statuses: (null | { slot: number; err: unknown })[];
  blockHeight?: number;
}): Connection {
  let call = 0;
  return {
    getSignatureStatuses: async () => ({
      value: [opts.statuses[Math.min(call++, opts.statuses.length - 1)]],
    }),
    getBlockHeight: async () => opts.blockHeight ?? 0,
  } as unknown as Connection;
}

describe("confirmSignature classification", () => {
  it("lands on a clean status", async () => {
    const c = clock();
    const outcome = await confirmSignature(
      mockConn({ statuses: [null, null, { slot: 123, err: null }] }),
      "sig",
      { ...c },
    );
    expect(outcome).toEqual({ status: "landed", slot: 123 });
  });

  it("classifies program error 6005 as missed_round/round_not_active", async () => {
    const err = { InstructionError: [2, { Custom: 6005 }] };
    expect(isRoundNotActive(err)).toBe(true);
    const outcome = await confirmSignature(
      mockConn({ statuses: [{ slot: 5, err }] }),
      "sig",
      { ...clock() },
    );
    expect(outcome).toEqual({ status: "missed_round", reason: "round_not_active" });
  });

  it("classifies other program errors as failed", async () => {
    const err = { InstructionError: [2, { Custom: 6007 }] };
    expect(isRoundNotActive(err)).toBe(false);
    const outcome = await confirmSignature(
      mockConn({ statuses: [{ slot: 5, err }] }),
      "sig",
      { ...clock() },
    );
    expect(outcome).toMatchObject({ status: "failed" });
  });

  it("classifies blockhash expiry as missed_round", async () => {
    const c = clock();
    const outcome = await confirmSignature(
      mockConn({ statuses: [null], blockHeight: 501 }),
      "sig",
      { ...c, lastValidBlockHeight: 500, pollMs: 600 },
    );
    expect(outcome).toEqual({ status: "missed_round", reason: "blockhash_expired" });
  });

  it("classifies a passed cutoff as missed_round after one grace poll", async () => {
    const c = clock();
    let polls = 0;
    const outcome = await confirmSignature(mockConn({ statuses: [null] }), "sig", {
      ...c,
      isPastCutoff: () => ++polls >= 1,
    });
    expect(outcome).toEqual({ status: "missed_round", reason: "cutoff_passed" });
    expect(polls).toBeGreaterThanOrEqual(2); // grace poll happened
  });

  it("times out when nothing resolves", async () => {
    const c = clock();
    const outcome = await confirmSignature(mockConn({ statuses: [null] }), "sig", {
      ...c,
      timeoutMs: 2_000,
    });
    expect(outcome).toEqual({ status: "timeout" });
  });
});
