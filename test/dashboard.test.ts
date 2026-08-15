/**
 * The dashboard ships as one big HTML/JS string, so nothing typechecks it and a
 * runtime error in render() blanks the page silently in the browser. These
 * tests extract the inline script, run it against a minimal DOM stub, and drive
 * render() with realistic payloads — including the degenerate ones (fresh DB,
 * missing intel, no vault) that are exactly when an operator most needs the
 * page to work.
 */
import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML } from "../src/ops/dashboard.js";

interface StubEl {
  id: string;
  textContent: string;
  innerHTML: string;
  className: string;
  style: Record<string, string>;
  querySelector(sel: string): StubEl;
}

/**
 * Children created via querySelector are registered in the same registry under
 * "<parent> <sel>" so assertions can reach into table bodies.
 */
function makeEl(id: string, registry: Map<string, StubEl>): StubEl {
  const el: StubEl = {
    id,
    textContent: "",
    innerHTML: "",
    className: "",
    style: {},
    querySelector(sel: string): StubEl {
      const key = id + " " + sel;
      let c = registry.get(key);
      if (!c) {
        c = makeEl(key, registry);
        registry.set(key, c);
      }
      return c;
    },
  };
  registry.set(id, el);
  return el;
}

/** Load the inline script and hand back its render entry points plus the DOM. */
function loadDashboard() {
  const m = DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("dashboard has no inline script");
  const src = m[1] as string;

  const els = new Map<string, StubEl>();
  for (const id of DASHBOARD_HTML.matchAll(/id="([a-zA-Z0-9_-]+)"/g)) {
    makeEl(id[1] as string, els);
  }
  const document = {
    getElementById(id: string): StubEl | null {
      return els.get(id) ?? null;
    },
  };
  const errors: string[] = [];
  const factory = new Function(
    "document",
    "fetch",
    "setInterval",
    "location",
    src + "\nreturn { render };",
  ) as (
    d: unknown,
    f: unknown,
    s: unknown,
    l: unknown,
  ) => { render: (...args: unknown[]) => void };

  const api = factory(
    document,
    () => Promise.reject(new Error("no network in test")),
    () => 0,
    { search: "?token=t" },
  );
  return { render: api.render, els, errors };
}

const status = () => ({
  ts: "2026-08-12T00:00:00Z",
  mode: "mainnet",
  paused: false,
  killSwitch: false,
  ingest: { fresh: true, slotAgeMs: 90, source: "grpc", lagSlots: 1, lagBlocking: false },
  round: { id: 11690, state: "Active", slotsToCutoff: 12, currentSlot: 438736754 },
  board: {
    tileStakesUsd: new Array(21).fill(14.3),
    totalUsd: 300.3,
    strikePoolUsd: 9926.78,
  },
  me: { streak: 30, tiles: [0, 1, 2], stakeUsd: 12 },
  pnl: { todayNetUsd: -7.5, deployedTodayUsd: 199, returnedTodayUsd: 191.5 },
  unclaimed: { usd: 8.1, shares: "141384", sharesUsd: 866.9 },
  caps: { maxPerRoundUsd: 1000, dailyLossCapUsd: 1000, dailyLossLeftUsd: 992.5 },
  prices: { btc: { usd: 63748.13, live: true }, sol: { usd: 76.34, live: true } },
});

const intel = () => ({
  windowRounds: 500,
  field: {
    rounds: 500,
    deploys: 16_500,
    distinctRivals: 33,
    avgDeploysPerRound: 33,
    automationShare: 0.92,
    fullBoardShare: 0.86,
    avgRivalStakeUsd: 14.2,
  },
  uniformity: { samples: 500, medianCov: 0.012, uniformShare: 0.94, blanketShare: 0.63, residualCov: 0.19 },
  fairness: {
    samples: 999,
    counts: new Array(21).fill(47),
    chiSquare: 7.72,
    degreesOfFreedom: 20,
    criticalValue05: 31.41,
    looksUniform: true,
  },
  rivalTiming: { samples: 16_500, p10: 2, p50: 18, p90: 44, afterUsShare: 0.11 },
  calibration: {
    landed: 98,
    modeledBps: 368,
    realizedUsdBps: -824,
    realizedSharesBps: 1376,
    realizedBps: 552,
    benchmarkBps: 85,
  },
  skips: [{ reason: "no_candidate", count: 402 }],
  strike: { rounds: 999, strikes: 1, roundsSinceLast: 990 },
});

const vault = () => ({
  enabled: true,
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
  pools: {
    slot: 438736754,
    epoch: {
      iterationId: 293,
      open: true,
      totalTickets: 502_189,
      myTickets: 5,
      poolUsd: 21_959.04,
      slotsToClose: 400,
      ticketEvUsd: 0.0393,
    },
    oneBtc: {
      iterationId: 19,
      open: true,
      totalTickets: 226_172,
      prizeUsd: 38_580.6,
      fillBps: 6050,
      ticketEvUsd: 0.1706,
    },
  },
  hashrateValue: { usdPerRawUnit: 0.001706, source: "derived" as const },
  recent: [{ kind: "epoch", iteration_id: 293, tickets: 5, claimed: 0 }],
});

const rounds = () => [
  { id: 11690, winning_tile: 4, deployed_usd: "300000000", miners_count: 34, strike_triggered: 0 },
];
const deploys = () => [
  {
    round_id: 11690,
    mask: 7,
    amount: "12000000",
    fired_slot: 100,
    landed_slot: 102,
    status: "landed",
  },
];
const comp = () => [
  {
    round_id: 11690,
    authority: "AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
    mask: 2_097_151,
    amount: "10000000",
    total_stake: "9200000",
    is_automation: 1,
    slot: 438736700,
  },
];
const health = () => ({
  ingestFresh: true,
  ingestSlotAgeMs: 90,
  solBalance: 0.51,
  usdcBalance: 4990,
  dbError: null,
});
const pnl = () => [
  { date: "2026-08-11", deployed: "199000000", returned: "191500000", net: "-7500000", fees_paid: "15920000" },
];

describe("dashboard render", () => {
  it("renders a fully-populated page without throwing", () => {
    const { render, els } = loadDashboard();
    expect(() =>
      render(status(), rounds(), deploys(), comp(), health(), vault(), pnl(), intel()),
    ).not.toThrow();

    expect(els.get("hero")!.innerHTML).toContain("Today net");
    expect(els.get("board")!.innerHTML).toContain("tile");
    expect(els.get("calibration")!.innerHTML).toContain("+552 bps");
    expect(els.get("field")!.innerHTML).toContain("33");
    expect(els.get("prices")!.innerHTML).toContain("63,748.13");
    expect(els.get("vaultpools")!.innerHTML).toContain("1-BTC prize");
    expect(els.get("fairbars")!.innerHTML).toContain("class=\"b");
    expect(els.get("timingbars")!.innerHTML).toContain("class=\"b");
  });

  it("verdict calls out a uniform field as no tile edge", () => {
    const { render, els } = loadDashboard();
    render(status(), rounds(), deploys(), comp(), health(), vault(), pnl(), intel());
    const v = els.get("verdict")!.innerHTML;
    expect(v).toContain("no tile edge");
    expect(v).toContain("94.0%");
  });

  it("verdict warns when realized edge trails the passive benchmark", () => {
    const { render, els } = loadDashboard();
    const i = intel();
    i.uniformity = { samples: 500, medianCov: 0.31, uniformShare: 0.1, blanketShare: 0.2, residualCov: 0.4 }; // edge exists
    i.calibration = { landed: 98, modeledBps: 368, realizedUsdBps: -900, realizedSharesBps: 920, realizedBps: 20, benchmarkBps: 85 };
    render(status(), rounds(), deploys(), comp(), health(), vault(), pnl(), i);
    const v = els.get("verdict")!.innerHTML;
    expect(v).toContain("below benchmark");
    expect(v).toContain("flat passive play would have done better");
  });

  it("verdict flags an over-optimistic model", () => {
    const { render, els } = loadDashboard();
    const i = intel();
    i.uniformity = { samples: 500, medianCov: 0.31, uniformShare: 0.1, blanketShare: 0.2, residualCov: 0.4 };
    i.calibration = { landed: 98, modeledBps: 2500, realizedUsdBps: -800, realizedSharesBps: 900, realizedBps: 100, benchmarkBps: 85 };
    render(status(), rounds(), deploys(), comp(), health(), vault(), pnl(), i);
    expect(els.get("verdict")!.innerHTML).toContain("optimistic");
  });

  it("survives a virgin bot: no intel, no vault, empty tables", () => {
    const { render, els } = loadDashboard();
    const s = status();
    s.board.tileStakesUsd = new Array(21).fill(0);
    s.board.totalUsd = 0;
    s.me = { streak: null as unknown as number, tiles: [], stakeUsd: 0 };
    expect(() => render(s, [], [], [], null, null, [], null)).not.toThrow();
    expect(els.get("verdict")!.innerHTML).toContain("no intel");
    expect(els.get("rounds tbody")!.innerHTML).toContain("no data yet");
    expect(els.get("vaultsub")!.textContent).toBe("unavailable");
  });

  it("handles intel present but every sub-section empty", () => {
    const { render, els } = loadDashboard();
    const empty = {
      windowRounds: 500,
      field: {
        rounds: 0,
        deploys: 0,
        distinctRivals: 0,
        avgDeploysPerRound: 0,
        automationShare: 0,
        fullBoardShare: 0,
        avgRivalStakeUsd: 0,
      },
      uniformity: { samples: 0, medianCov: null, uniformShare: null, blanketShare: null, residualCov: null },
      fairness: null,
      rivalTiming: null,
      calibration: {
        landed: 0,
        modeledBps: null,
        realizedUsdBps: null,
        realizedSharesBps: null,
        realizedBps: null,
        benchmarkBps: 85,
      },
      skips: [],
      strike: { rounds: 0, strikes: 0, roundsSinceLast: null },
    };
    expect(() =>
      render(status(), rounds(), deploys(), comp(), health(), vault(), pnl(), empty),
    ).not.toThrow();
    expect(els.get("verdict")!.innerHTML).toContain("unproven");
    expect(els.get("timingsub")!.textContent).toBe("no timing data yet");
    expect(els.get("fairsub")!.textContent).toBe("no resolved rounds yet");
  });

  it("shows a lagging-but-alive ingest as its own state, not healthy", () => {
    const { render, els } = loadDashboard();
    const s = status();
    s.ingest = { fresh: true, slotAgeMs: 90, source: "grpc", lagSlots: 38, lagBlocking: true };
    render(s, rounds(), deploys(), comp(), health(), vault(), pnl(), intel());
    expect(els.get("ingest")!.innerHTML).toContain("LAGGING 38 slots");
    expect(els.get("ingest")!.className).toContain("warn");
  });

  it("marks a fallback price as a problem, not a footnote", () => {
    const { render, els } = loadDashboard();
    const s = status();
    s.prices = { btc: { usd: 65000, live: false }, sol: { usd: 75, live: true } };
    render(s, rounds(), deploys(), comp(), health(), vault(), pnl(), intel());
    expect(els.get("prices")!.innerHTML).toContain("FALLBACK");
  });
});
