import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { SignatureStatusBatcher, withBatchedStatuses } from "../src/exec/status-batcher.js";

describe("SignatureStatusBatcher — one status call for every in-flight leg", () => {
  it("coalesces 21 concurrent polls into one RPC call and hands each caller its own slice", async () => {
    const seen: string[][] = [];
    const fake = {
      getSignatureStatuses: async (sigs: string[]) => {
        seen.push(sigs);
        return { context: { slot: 99 }, value: sigs.map((s) => (s.endsWith("5") ? { slot: 98, confirmations: 1, err: null, confirmationStatus: "processed" } : null)) };
      },
    } as unknown as Connection;
    const b = new SignatureStatusBatcher(fake, 5);
    const sigs = Array.from({ length: 21 }, (_, i) => `sig${i}`);
    const results = await Promise.all(sigs.map((s) => b.getSignatureStatuses([s])));
    expect(b.calls).toBe(1);
    expect(seen[0]).toHaveLength(21);
    expect(results[5]!.value[0]).toMatchObject({ slot: 98 });
    expect(results[4]!.value[0]).toBeNull();
    expect(results[0]!.context.slot).toBe(99);
  });

  it("chunks above 256 signatures and rejects every waiter when the RPC fails", async () => {
    let calls = 0;
    const ok = { getSignatureStatuses: async (sigs: string[]) => { calls++; return { context: { slot: 1 }, value: sigs.map(() => null) }; } } as unknown as Connection;
    const b = new SignatureStatusBatcher(ok, 1);
    await Promise.all(Array.from({ length: 300 }, (_, i) => b.getSignatureStatuses([`s${i}`])));
    expect(calls).toBe(2);
    const bad = new SignatureStatusBatcher({ getSignatureStatuses: async () => { throw new Error("429"); } } as unknown as Connection, 1);
    await expect(Promise.all([bad.getSignatureStatuses(["a"]), bad.getSignatureStatuses(["b"])])).rejects.toThrow("429");
  });

  it("the proxied connection batches statuses and passes every other method through", async () => {
    const fake = {
      getSignatureStatuses: async (sigs: string[]) => ({ context: { slot: 1 }, value: sigs.map(() => null) }),
      getBlockHeight: async () => 1234,
    } as unknown as Connection;
    const b = new SignatureStatusBatcher(fake, 1);
    const c = withBatchedStatuses(fake, b);
    await Promise.all([c.getSignatureStatuses(["x"]), c.getSignatureStatuses(["y"])]);
    expect(b.calls).toBe(1);
    expect(await c.getBlockHeight()).toBe(1234);
  });
});

describe("FeeEstimator — priced on the round's write locks", () => {
  it("passes the locked accounts and takes the p90 of the per-slot minimum fees", async () => {
    const { FeeEstimator } = await import("../src/exec/fees.js");
    const { Keypair } = await import("@solana/web3.js");
    let locked: unknown[] = [];
    const conn = {
      getRecentPrioritizationFees: async (cfg: { lockedWritableAccounts: unknown[] }) => {
        locked = cfg.lockedWritableAccounts;
        return Array.from({ length: 100 }, (_, i) => ({ slot: i, prioritizationFee: (i + 1) * 1_000 }));
      },
    } as unknown as Connection;
    const est = new FeeEstimator({ minMicroLamports: 1_000, maxMicroLamports: 1_000_000 });
    const round = Keypair.generate().publicKey;
    await est.refreshFromRpc(conn, [round]);
    expect(locked).toEqual([round]);
    expect(est.currentMicroLamportsPerCu()).toBe(91_000); // values[90] of 1k..100k
  });
});

describe("the sender reports send errors instead of swallowing them", () => {
  it("counts sendRawTransaction failures and keeps the last error text", async () => {
    const { RaceSender } = await import("../src/exec/sender.js");
    let polls = 0;
    const conn = {
      sendRawTransaction: async () => { throw new Error("429 Too Many Requests"); },
      getSignatureStatuses: async (sigs: string[]) => ({ context: { slot: 1 }, value: sigs.map(() => (++polls >= 3 ? { slot: 5, confirmations: 1, err: null, confirmationStatus: "processed" } : null)) }),
      getBlockHeight: async () => 1,
    } as unknown as Connection;
    let t = 0;
    const sender = new RaceSender({ mode: "devnet", connections: [conn] });
    const r = await sender.fire({ signature: "s", serialized: Buffer.from([1]), lastValidBlockHeight: 10_000 }, { now: () => t, sleep: async (ms: number) => void (t += ms) });
    expect(r.timing.sendErrors).toBeGreaterThanOrEqual(1);
    expect(r.timing.lastSendError).toContain("429");
  });
});
