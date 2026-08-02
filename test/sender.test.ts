import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { RaceSender } from "../src/exec/sender.js";

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

interface SendRecord {
  bytes: Buffer;
  options: { skipPreflight?: boolean; maxRetries?: number };
}

function mockConnection(opts: {
  sends: SendRecord[];
  landAfterPolls?: number;
}): Connection {
  let polls = 0;
  return {
    sendRawTransaction: async (bytes: Buffer, options: SendRecord["options"]) => {
      opts.sends.push({ bytes: Buffer.from(bytes), options });
      return "sig";
    },
    getSignatureStatuses: async () => {
      polls++;
      const landed =
        opts.landAfterPolls !== undefined && polls >= opts.landAfterPolls;
      return { value: [landed ? { slot: 777, err: null } : null] };
    },
    getBlockHeight: async () => 0,
  } as unknown as Connection;
}

const candidate = {
  signature: "testsig",
  serialized: Buffer.from([1, 2, 3, 4]),
  meta: { mask: 1, amount: "5000000" },
};

describe("dry mode (CLAUDE.md ground rule)", () => {
  it("never touches the wire and returns a synthetic confirmation", async () => {
    const poison = {
      sendRawTransaction: () => {
        throw new Error("dry mode must not send");
      },
    } as unknown as Connection;
    const sender = new RaceSender({ mode: "dry", connections: [poison] });
    const result = await sender.fire(candidate, { ...clock() });
    expect(result.outcome).toBe("dry");
    expect(result.signature).toBe("testsig");
    expect(result.timing.sendAttempts).toBe(0);
  });
});

describe("race protocol", () => {
  it("blasts identical bytes to every endpoint with skipPreflight + maxRetries 0", async () => {
    const sendsA: SendRecord[] = [];
    const sendsB: SendRecord[] = [];
    const primary = mockConnection({ sends: sendsA, landAfterPolls: 3 });
    const secondary = mockConnection({ sends: sendsB });
    const sender = new RaceSender({ mode: "devnet", connections: [primary, secondary] });

    const result = await sender.fire(candidate, { ...clock() });
    expect(result.outcome).toBe("landed");
    expect(result.landedSlot).toBe(777);
    expect(result.timing.sendAttempts).toBeGreaterThanOrEqual(1);
    expect(sendsA.length).toBeGreaterThanOrEqual(1);
    expect(sendsB.length).toBe(sendsA.length); // raced in lockstep
    for (const record of [...sendsA, ...sendsB]) {
      expect(record.bytes.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
      expect(record.options).toMatchObject({ skipPreflight: true, maxRetries: 0 });
    }
  });

  it("resends until confirmation, then stops", async () => {
    const sends: SendRecord[] = [];
    const primary = mockConnection({ sends, landAfterPolls: 4 });
    const sender = new RaceSender({ mode: "devnet", connections: [primary] });
    const result = await sender.fire(candidate, { ...clock(), resendIntervalMs: 400 });
    expect(result.outcome).toBe("landed");
    expect(sends.length).toBeGreaterThanOrEqual(2); // resent at least once
    expect(sends.length).toBeLessThan(30); // and stopped after landing
  });

  it("stops blasting past the cutoff and reports missed_round", async () => {
    const sends: SendRecord[] = [];
    const primary = mockConnection({ sends }); // never lands
    const sender = new RaceSender({ mode: "devnet", connections: [primary] });
    let cutoff = false;
    const c = clock();
    const result = await sender.fire(candidate, {
      ...c,
      isPastCutoff: () => cutoff || (cutoff = c.now() > 800),
    });
    expect(result.outcome).toBe("missed_round");
    expect(result.detail).toBe("cutoff_passed");
    expect(sends.length).toBeLessThanOrEqual(4);
  });

  it("times out when nothing lands", async () => {
    const sender = new RaceSender({
      mode: "devnet",
      connections: [mockConnection({ sends: [] })],
    });
    const result = await sender.fire(candidate, { ...clock(), timeoutMs: 3_000 });
    expect(result.outcome).toBe("timeout");
  });

  it("refuses construction without connections outside dry mode", () => {
    expect(() => new RaceSender({ mode: "devnet", connections: [] })).toThrow();
  });

  it("refuses a mainnet sender without MAINNET_CONFIRM (ground rule)", () => {
    const conn = mockConnection({ sends: [] });
    expect(() => new RaceSender({ mode: "mainnet", connections: [conn] })).toThrow(
      /MAINNET_CONFIRM/,
    );
    expect(
      () =>
        new RaceSender({ mode: "mainnet", connections: [conn], mainnetConfirmed: true }),
    ).not.toThrow();
  });
});
