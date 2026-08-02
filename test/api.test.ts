import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MonitorApi } from "../src/ops/api.js";
import type { MonitorData } from "../src/ops/monitor.js";

const fakeData: MonitorData = {
  status: () => ({
    ts: "2026-08-02T00:00:00Z",
    mode: "dry",
    paused: false,
    killSwitch: false,
    ingest: { fresh: true, slotAgeMs: 100, source: "ws-rpc" },
    round: { id: 42, state: "Active", slotsToCutoff: 30, currentSlot: 1000 },
    board: { tileStakesUsd: new Array(21).fill(0), totalUsd: 0, strikePoolUsd: 5 },
    me: { streak: 3, tiles: [0, 1], stakeUsd: 2 },
    pnl: { todayNetUsd: -1.5, deployedTodayUsd: 5, returnedTodayUsd: 3.5 },
    unclaimed: { usd: 8.1, shares: "141384" },
    caps: { maxPerRoundUsd: 1000, dailyLossCapUsd: 1000, dailyLossLeftUsd: 998.5 },
  }),
  pnlDaily: () => ({ date: "2026-08-02", net: "-1500000" }),
  // clamp mirrors monitor.ts's contract (max 200)
  recentRounds: (n) => Array.from({ length: Math.min(n, 200) }, (_, i) => ({ id: 42 - i })),
  recentDeploys: (n) => Array.from({ length: Math.min(n, 200) }, (_, i) => ({ round_id: 42 - i })),
  recentCompetitors: (n) =>
    Array.from({ length: Math.min(n, 200) }, (_, i) => ({ round_id: 42 - i })),
  health: async () => ({
    ingestFresh: true,
    ingestSlotAgeMs: 100,
    solBalance: 0.5,
    usdcBalance: 4990,
    dbError: null,
  }),
};

const TOKEN = "test-secret-token";
let api: MonitorApi;
let base: string;

beforeAll(async () => {
  api = new MonitorApi({
    token: TOKEN,
    host: "127.0.0.1",
    port: 0, // ephemeral
    data: fakeData,
    mode: "dry",
    startedAtMs: Date.now(),
  });
  await api.start();
  base = `http://127.0.0.1:${api.address()!.port}`;
});
afterAll(async () => {
  await api.stop();
});

const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

describe("MonitorApi — auth", () => {
  it("rejects /api without a token", async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("accepts a bearer token", async () => {
    const res = await fetch(`${base}/api/status`, auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { round: { id: number }; mode: string };
    expect(body.round.id).toBe(42);
    expect(body.mode).toBe("dry");
  });

  it("accepts a query-param token (for the dashboard/browser)", async () => {
    const res = await fetch(`${base}/api/status?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });
});

describe("MonitorApi — read-only", () => {
  it("liveness /health needs no auth", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("serves the dashboard HTML at / without auth", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("STRATEGY MONITOR");
  });

  it("refuses non-GET methods (no control surface)", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${base}/api/status`, { method, ...auth });
      expect(res.status, method).toBe(405);
    }
  });

  it("has no control endpoints", async () => {
    for (const path of ["/api/kill", "/api/pause", "/api/deploy", "/api/config"]) {
      const res = await fetch(`${base}${path}`, auth);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("MonitorApi — data endpoints", () => {
  const json = async (path: string): Promise<any> =>
    (await fetch(`${base}${path}`, auth)).json();

  it("status/pnl/health/rounds/deploys/competitors", async () => {
    expect((await json("/api/pnl")).date).toBe("2026-08-02");
    expect((await json("/api/health")).usdcBalance).toBe(4990);
    expect((await json("/api/rounds?limit=5")).length).toBe(5);
    expect((await json("/api/deploys?limit=3")).length).toBe(3);
    expect((await json("/api/competitors?limit=7")).length).toBe(7);
  });

  it("clamps limit to a sane maximum", async () => {
    expect((await json("/api/rounds?limit=99999")).length).toBeLessThanOrEqual(200);
  });
});
