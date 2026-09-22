/**
 * The gRPC source must rebuild a stream whose slot feed goes silent without
 * an error or end (a half-open connection — the 2026-09-21 outage: "slot
 * stream quiet for 243865ms" with the reconnect loop never triggered).
 */
import { EventEmitter } from "node:events";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeStream extends EventEmitter {
  destroyed = 0;
  write(): boolean {
    return true;
  }
  destroy(err?: Error): void {
    if (this.destroyed > 0) return; // a real stream ignores a second destroy
    this.destroyed++;
    if (err) this.emit("error", err);
    this.emit("close");
  }
}

const streams: FakeStream[] = [];
const requests: { fromSlot?: string }[] = [];
const ctorArgs: unknown[][] = [];
/** Set to make the next replay (fromSlot) subscription die at once, like a server past retention. */
let refuseReplay = false;
class FakeClient {
  constructor(...args: unknown[]) {
    ctorArgs.push(args);
  }
  async connect(): Promise<void> {}
  async subscribe(req: { fromSlot?: string }): Promise<FakeStream> {
    const s = new FakeStream();
    streams.push(s);
    requests.push(req);
    if (refuseReplay && req.fromSlot !== undefined) {
      setTimeout(() => s.destroy(new Error("from_slot too old")), 1);
    }
    return s;
  }
}

vi.mock("@triton-one/yellowstone-grpc", () => ({
  default: FakeClient,
  CommitmentLevel: { PROCESSED: 0, CONFIRMED: 1, FINALIZED: 2 },
}));

describe("YellowstoneIngest silence watchdog", () => {
  beforeEach(() => {
    streams.length = 0;
    requests.length = 0;
    ctorArgs.length = 0;
    refuseReplay = false;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroys a stream whose slot feed goes quiet past the grace and reconnects", async () => {
    const { YellowstoneIngest } = await import("../src/ingest/grpc.js");
    const src = new YellowstoneIngest({
      endpoint: "http://fake",
      programId: Keypair.generate().publicKey,
      watchAccounts: [],
      stalenessMs: 1_500, // grace = max(5 × 1.5 s, 7.5 s) = 7.5 s
    });
    const status: { connected: boolean; detail?: string }[] = [];
    src.on("status", (s) => status.push(s));
    await src.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(streams).toHaveLength(1);
    const first = streams[0]!;

    // Live slots keep the stream alive well past the grace.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(3_000);
      first.emit("data", { slot: { slot: String(1_000 + i) }, filters: [] });
    }
    expect(first.destroyed).toBe(0);

    // Then silence: no error, no end — just nothing. The watchdog must act.
    await vi.advanceTimersByTimeAsync(7_500 + 2_500 + 100);
    expect(first.destroyed).toBe(1);
    expect(status.some((s) => !s.connected && /silent/.test(s.detail ?? ""))).toBe(true);

    // The connect loop reconnected (backoff ≤ 750 ms at attempt 0) and asked
    // LaserStream to replay from the last slot it saw, so the gap is filled.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(streams.length).toBeGreaterThanOrEqual(2);
    expect(status.filter((s) => s.connected)).toHaveLength(2);
    expect(requests[0]!.fromSlot).toBeUndefined();
    expect(requests[1]!.fromSlot).toBe("1003");
    expect(status[status.length - 1]!.detail).toMatch(/replaying from slot 1003/);
    expect(src.stats()).toMatchObject({ reconnects: 1, lastSlot: 1003 });
    // The transport carries HTTP/2 keepalive so a half-open socket errors at
    // the transport too, and no per-call deadline that would kill the stream.
    const channel = ctorArgs[0]![2] as Record<string, unknown>;
    expect(channel.grpcHttp2KeepAliveInterval).toBe(10_000);
    expect(channel.grpcKeepAliveTimeout).toBe(5_000);
    expect(channel.grpcTimeout).toBeUndefined();
    await src.stop();
  });

  it("falls back to a live-only subscription when the replay is refused", async () => {
    const { YellowstoneIngest } = await import("../src/ingest/grpc.js");
    const src = new YellowstoneIngest({
      endpoint: "http://fake",
      programId: Keypair.generate().publicKey,
      watchAccounts: [],
      stalenessMs: 1_500,
    });
    await src.start();
    await vi.advanceTimersByTimeAsync(10);
    streams[0]!.emit("data", { slot: { slot: "500" }, filters: [] });
    refuseReplay = true;
    streams[0]!.destroy(new Error("transport reset"));
    await vi.advanceTimersByTimeAsync(1_000); // reconnect #1: replay from 500, refused at once
    expect(requests[1]!.fromSlot).toBe("500");
    await vi.advanceTimersByTimeAsync(2_500); // reconnect #2: live only
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests[2]!.fromSlot).toBeUndefined();
    const stopping = src.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
  });

  it("gives a fresh stream the full grace even when the last slot is long ago", async () => {
    const { YellowstoneIngest } = await import("../src/ingest/grpc.js");
    const src = new YellowstoneIngest({
      endpoint: "http://fake",
      programId: Keypair.generate().publicKey,
      watchAccounts: [],
      stalenessMs: 1_500,
    });
    await src.start();
    await vi.advanceTimersByTimeAsync(10);
    const first = streams[0]!;
    first.emit("data", { slot: { slot: "1" }, filters: [] });
    await vi.advanceTimersByTimeAsync(10_100); // silent → destroyed, reconnect
    expect(first.destroyed).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = streams[1]!;
    // The old slot is ~11 s stale, but the new stream is young: not killed yet.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.destroyed).toBe(0);
    // ...and it is killed once ITS own silence exceeds the grace.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(second.destroyed).toBe(1);
    // The loop is in its backoff sleep now; let the fake clock run it out.
    const stopping = src.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
  });
});
