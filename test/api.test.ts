import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MonitorApi } from "../src/ops/api.js";
import type { MonitorData } from "../src/ops/monitor.js";

const fakeData: MonitorData = {
  status: () => ({
    ts: "2026-08-02T00:00:00Z",
    mode: "dry",
    paused: false,
    killSwitch: false,
    ingest: { fresh: true, slotAgeMs: 100, source: "ws-rpc", lagSlots: 1, lagBlocking: false },
    round: { id: 42, state: "Active", slotsToCutoff: 30, currentSlot: 1000 },
    board: { tileStakesUsd: new Array(21).fill(0), totalUsd: 0, strikePoolUsd: 5 },
    me: { streak: 3, tiles: [0, 1], stakeUsd: 2 },
    pnl: { todayNetUsd: -1.5, deployedTodayUsd: 5, returnedTodayUsd: 3.5 },
    unclaimed: { usd: 8.1, shares: "141384", sharesUsd: 0.13, tokenShares: "0", tokenSharesUsd: 0 },
    markedNetTodayUsd: -1.5,
    tokenFeed: null,
    wallets: [],
    game: { version: "v2", tokenYield: 0.015, satsVaultApr: 3.15, tokenVaultApr: null, carry: null, carryHorizonDays: 0 },
    caps: { maxPerRoundUsd: 1000, dailyLossCapUsd: 1000, dailyLossLeftUsd: 998.5 },
    prices: { btc: { usd: 118_423.1, live: true }, sol: { usd: 212.55, live: true } },
  }),
  pnlDaily: (n: number) =>
    Array.from({ length: Math.min(n, 365) }, (_, i) => ({
      date: "2026-08-0" + (2 + i),
      net: "-1500000",
    })),
  // clamp mirrors monitor.ts's contract (max 200)
  recentRounds: (n) => Array.from({ length: Math.min(n, 200) }, (_, i) => ({ id: 42 - i })),
  recentDeploys: (n) => Array.from({ length: Math.min(n, 200) }, (_, i) => ({ round_id: 42 - i })),
  recentCompetitors: (n) =>
    Array.from({ length: Math.min(n, 200) }, (_, i) => ({ round_id: 42 - i })),
  vault: () => ({
    enabled: false,
    hashrate: 1795,
    unclaimedHashrate: 607,
    epoch: { ticketsBought: 5, iterationsPlayed: 1, iterationsClaimed: 0 },
    oneBtc: { ticketsBought: 2, iterationsPlayed: 1, iterationsClaimed: 0 },
    economics: {
      hashrateSpentRaw: 700,
      usdClaimed: 0,
      btcClaimedUsd: 0,
      iterationsResolved: 0,
      iterationsPaid: 0,
      usdPerRawUnit: null,
    },
    pools: null,
    hashrateValue: { usdPerRawUnit: 0, source: "none" as const },
    recent: [{ kind: "epoch", iteration_id: 293, tickets: 5, claimed: 0 }],
  }),
  intel: (windowRounds: number) => ({
    windowRounds,
    field: {
      rounds: 100,
      deploys: 3300,
      distinctRivals: 33,
      avgDeploysPerRound: 33,
      automationShare: 0.9,
      fullBoardShare: 0.85,
      avgRivalStakeUsd: 14.2,
    },
    uniformity: {
      samples: 100,
      medianCov: 0.012,
      uniformShare: 0.94,
      blanketShare: 0.63,
      residualCov: 0.19,
    },
    fairness: {
      samples: 999,
      counts: new Array(21).fill(47),
      chiSquare: 7.72,
      degreesOfFreedom: 20,
      criticalValue05: 31.41,
      looksUniform: true,
    },
    rivalTiming: { samples: 3300, p10: 2, p50: 18, p90: 44, afterUsShare: 0.11 },
    calibration: {
      landed: 98,
      modeledBps: 368,
      realizedUsdBps: -824,
      realizedSharesBps: 1376, realizedTokenBps: 0,
      realizedBps: 552,
      benchmarkBps: 85,
    },
    skips: [{ reason: "no_candidate", count: 402 }],
    strike: { rounds: 999, strikes: 1, roundsSinceLast: 990 },
  }),
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

  it("serves the vault view", async () => {
    const res = await fetch(`${base}/api/vault`, auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { epoch: { ticketsBought: number }; hashrate: number };
    expect(body.epoch.ticketsBought).toBe(5);
    expect(body.hashrate).toBe(1795);
  });

  it("serves intel, defaulting and honouring the window param", async () => {
    const def = (await (await fetch(`${base}/api/intel`, auth)).json()) as {
      windowRounds: number;
      field: { distinctRivals: number };
    };
    expect(def.windowRounds).toBe(500);
    expect(def.field.distinctRivals).toBe(33);

    const windowed = (await (
      await fetch(`${base}/api/intel?window=50`, auth)
    ).json()) as { windowRounds: number };
    expect(windowed.windowRounds).toBe(50);
  });

  it("intel requires a token like every other /api route", async () => {
    expect((await fetch(`${base}/api/intel`)).status).toBe(401);
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
    expect((await json("/api/pnl"))[0].date).toBe("2026-08-02");
    expect((await json("/api/pnl?limit=7")).length).toBe(7);
    expect((await json("/api/health")).usdcBalance).toBe(4990);
    expect((await json("/api/rounds?limit=5")).length).toBe(5);
    expect((await json("/api/deploys?limit=3")).length).toBe(3);
    expect((await json("/api/competitors?limit=7")).length).toBe(7);
  });

  it("clamps limit to a sane maximum", async () => {
    expect((await json("/api/rounds?limit=99999")).length).toBeLessThanOrEqual(200);
  });
});
