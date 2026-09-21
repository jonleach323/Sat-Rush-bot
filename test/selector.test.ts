import { describe, expect, it } from "vitest";
import { TILES_COUNT, evOfAllocation, type EvContext } from "../src/strategy/ev.js";
import { selectAllocation, type SelectorConfig } from "../src/strategy/selector.js";
import { usdToBase } from "../src/units.js";
import { seededRng } from "./helpers.js";

const FEES = { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 };
const zeroStakes = () => new Array<bigint>(TILES_COUNT).fill(0n);

function ctx(stakes: bigint[], multiplier = 1): EvContext {
  return { predictedStakes: stakes, fees: FEES, multiplier, semantics: "raw" };
}

function cfg(overrides: Partial<SelectorConfig> = {}): SelectorConfig {
  return {
    strategy: "water_filling",
    ladder: [usdToBase(1)],
    maxPerRound: usdToBase(50),
    minDeploy: usdToBase(1),
    kEmptiest: 3,
    rng: seededRng(7),
    ...overrides,
  };
}

/** Board with a fat pot to chase: 2 empty tiles, 19 tiles at $10. */
function chaseBoard(): bigint[] {
  const stakes = zeroStakes();
  for (let i = 2; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
  return stakes;
}

describe("water-filling (acceptance)", () => {
  it("beats the single-emptiest allocation on a constructed case", () => {
    const c = ctx(chaseBoard());
    const selection = selectAllocation(c, cfg());
    expect(selection.kind).toBe("deploy");
    if (selection.kind !== "deploy") return;

    // Single-emptiest alternative: everything the selector spent, on tile 0.
    const single = zeroStakes();
    single[0] = selection.totalGross;
    const singleEv = evOfAllocation(c, single);
    expect(selection.ev).toBeGreaterThan(singleEv);
    // And it spread across both empty tiles.
    expect(selection.tiles).toEqual([0, 1]);
  });

  it("stops on marginal EV ≤ 0 well below the cap", () => {
    const c = ctx(chaseBoard());
    const selection = selectAllocation(c, cfg({ maxPerRound: usdToBase(50) }));
    expect(selection.kind).toBe("deploy");
    if (selection.kind !== "deploy") return;
    // One quantum per empty tile is optimal: a second quantum on a tile you
    // already own outright cannot raise your share (own-dilution), and
    // quanta on $10 tiles have negative marginal EV.
    expect(selection.totalGross).toBe(usdToBase(2));
    expect(selection.totalGross).toBeLessThan(usdToBase(50));
  });

  it("never exceeds MAX_PER_ROUND (property over random boards)", () => {
    const rng = seededRng(99);
    for (let iter = 0; iter < 200; iter++) {
      const stakes = zeroStakes().map(() =>
        rng() < 0.4 ? 0n : usdToBase(Math.floor(rng() * 200)),
      );
      const maxPerRound = usdToBase(1 + Math.floor(rng() * 20));
      const selection = selectAllocation(
        ctx(stakes, 1 + rng() * 3),
        cfg({ maxPerRound, rng }),
      );
      if (selection.kind === "deploy") {
        expect(selection.totalGross <= maxPerRound).toBe(true);
        const sum = selection.allocation.reduce((a, b) => a + b, 0n);
        expect(sum).toBe(selection.totalGross);
        expect(selection.tiles.length).toBeGreaterThan(0);
      }
    }
  });

  it("skips when no tile has positive marginal EV (empty board, fees)", () => {
    const selection = selectAllocation(ctx(zeroStakes()), cfg());
    expect(selection).toMatchObject({ kind: "skip", reason: "no_positive_marginal_ev" });
  });

  it("respects min_deploy: pads up to it, or skips if padding turns EV negative", () => {
    // Marginal pot to chase: EV-positive at $1 but thin.
    const stakes = zeroStakes();
    for (let i = 1; i < TILES_COUNT; i++) stakes[i] = usdToBase(2);
    const c = ctx(stakes);

    // min deploy $5 forces padding beyond the optimum ($1 on tile 0).
    const padded = selectAllocation(c, cfg({ minDeploy: usdToBase(5) }));
    if (padded.kind === "deploy") {
      expect(padded.totalGross).toBeGreaterThanOrEqual(usdToBase(5));
      expect(padded.ev).toBeGreaterThan(0);
    } else {
      expect(padded.reason).toBe("min_deploy_padding_made_ev_negative");
    }

    // min deploy above the cap → structurally impossible.
    const impossible = selectAllocation(
      c,
      cfg({ minDeploy: usdToBase(10), maxPerRound: usdToBase(3) }),
    );
    expect(impossible.kind).toBe("skip");
  });
});

describe("minimum-edge floor", () => {
  // A board with only modest leverage: tile 0 sits below a $10 field, so the
  // snipe is +EV but thin — exactly the kind of round the live bot bled on.
  function thinBoard(): bigint[] {
    const stakes = zeroStakes().map(() => usdToBase(10));
    stakes[0] = usdToBase(5);
    return stakes;
  }

  it("skips a positive-but-thin round that fires with the floor off", () => {
    const c = ctx(thinBoard());
    const open = selectAllocation(c, cfg({ minEdgeBps: 0 }));
    expect(open.kind).toBe("deploy");
    if (open.kind !== "deploy") return;

    // The allocation/EV are independent of the floor (the floor only gates the
    // final return), so we can bracket the realized edge exactly.
    const edgeBps = (open.ev / Number(open.totalGross)) * 10_000;
    const above = selectAllocation(c, cfg({ minEdgeBps: Math.ceil(edgeBps) + 1 }));
    expect(above).toMatchObject({ kind: "skip", reason: "below_min_edge" });
    const below = selectAllocation(
      c,
      cfg({ minEdgeBps: Math.max(0, Math.floor(edgeBps) - 1) }),
    );
    expect(below.kind).toBe("deploy");
  });

  it("still fires a fat edge under a strict floor", () => {
    // chaseBoard: solo ownership of empty tiles in a ~$190 pot → edge ≫ 100%.
    const sel = selectAllocation(ctx(chaseBoard()), cfg({ minEdgeBps: 5000 }));
    expect(sel.kind).toBe("deploy");
  });

  it("applies to the k_emptiest fallback too", () => {
    const c = ctx(thinBoard());
    const open = selectAllocation(
      c,
      cfg({ strategy: "k_emptiest", ladder: [usdToBase(1)], kEmptiest: 1, minEdgeBps: 0 }),
    );
    expect(open.kind).toBe("deploy");
    if (open.kind !== "deploy") return;
    const edgeBps = (open.ev / Number(open.totalGross)) * 10_000;
    const above = selectAllocation(
      c,
      cfg({
        strategy: "k_emptiest",
        ladder: [usdToBase(1)],
        kEmptiest: 1,
        minEdgeBps: Math.ceil(edgeBps) + 1,
      }),
    );
    expect(above).toMatchObject({ kind: "skip", reason: "below_min_edge" });
  });
});

describe("fractional-Kelly sizing", () => {
  it("no-ops when kellyFraction/bankroll are unset (pure EV-max)", () => {
    const c = ctx(chaseBoard());
    const plain = selectAllocation(c, cfg());
    const kellyOff = selectAllocation(c, cfg({ kellyFraction: 0 }));
    expect(kellyOff).toEqual(plain);
  });

  it("reduces the stake when the bankroll is small relative to the edge", () => {
    // A cap-bound fat board: many cheap tiles keep the marginal quantum +EV past
    // a big cap, so EV-max wants the whole cap.
    const stakes = zeroStakes();
    for (let i = 2; i < 15; i++) stakes[i] = usdToBase(1);
    for (let i = 15; i < TILES_COUNT; i++) stakes[i] = usdToBase(200);
    const c = ctx(stakes);
    const evMax = selectAllocation(c, cfg({ maxPerRound: usdToBase(50) }));
    expect(evMax.kind).toBe("deploy");
    if (evMax.kind !== "deploy") return;

    // With a tiny bankroll, half-Kelly caps the stake well below the EV-max bet.
    const kelly = selectAllocation(
      c,
      cfg({ maxPerRound: usdToBase(50), kellyFraction: 0.5, bankrollBase: usdToBase(20) }),
    );
    expect(kelly.kind).toBe("deploy");
    if (kelly.kind !== "deploy") return;
    expect(kelly.totalGross).toBeLessThan(evMax.totalGross);
  });

  it("does not raise the stake above the EV-max bet, even with a huge bankroll", () => {
    const c = ctx(chaseBoard());
    const evMax = selectAllocation(c, cfg());
    if (evMax.kind !== "deploy") return;
    const kelly = selectAllocation(
      c,
      cfg({ kellyFraction: 1, bankrollBase: usdToBase(1_000_000) }),
    );
    expect(kelly.kind).toBe("deploy");
    if (kelly.kind !== "deploy") return;
    // Empty-tile own-dilution stops EV-max at $2; Kelly can't push past that.
    expect(kelly.totalGross).toBe(evMax.totalGross);
  });

  it("skips when Kelly sizes below the on-chain minimum deploy", () => {
    // Thin-but-positive edge (tile 0 below a $10 field) + tiny bankroll →
    // growth-optimal stake < min deploy → sit out rather than over-bet the min.
    const stakes = zeroStakes().map(() => usdToBase(10));
    stakes[0] = usdToBase(5);
    // Sanity: it's a genuine deploy with Kelly off.
    const base = selectAllocation(ctx(stakes), cfg({ minEdgeBps: 0 }));
    expect(base.kind).toBe("deploy");
    const sel = selectAllocation(
      ctx(stakes),
      cfg({
        minEdgeBps: 0,
        kellyFraction: 0.5,
        bankrollBase: usdToBase(2),
        minDeploy: usdToBase(1),
      }),
    );
    expect(sel).toMatchObject({ kind: "skip", reason: "kelly_below_min_deploy" });
  });
});

describe("cap-bound detection (MAX EXTRACTION telemetry)", () => {
  it("flags capBound when MAX_PER_ROUND binds before marginal EV does", () => {
    // Whale tiles build a fat pot; many cheap $1 tiles keep the marginal
    // quantum +EV far past a tiny $2 cap (share ≈ 0.48 on a $1 tile,
    // pot ≈ $1,050 → next quantum worth ~$24 gross).
    const stakes = zeroStakes();
    for (let i = 2; i < 15; i++) stakes[i] = usdToBase(1);
    for (let i = 15; i < TILES_COUNT; i++) stakes[i] = usdToBase(200);
    const selection = selectAllocation(
      ctx(stakes),
      cfg({ maxPerRound: usdToBase(2) }),
    );
    expect(selection.kind).toBe("deploy");
    if (selection.kind !== "deploy") return;
    expect(selection.totalGross).toBe(usdToBase(2));
    expect(selection.capBound).toBe(true);
    expect(selection.marginalEvAtStop).toBeGreaterThan(0);
  });

  it("does not flag capBound when the EV stop binds first", () => {
    const selection = selectAllocation(ctx(chaseBoard()), cfg({ maxPerRound: usdToBase(50) }));
    expect(selection.kind).toBe("deploy");
    if (selection.kind !== "deploy") return;
    expect(selection.totalGross).toBeLessThan(usdToBase(50));
    expect(selection.capBound).toBe(false);
  });
});

describe("k_emptiest fallback", () => {
  it("puts the full ladder amount on one of the K emptiest tiles", () => {
    const stakes = chaseBoard(); // tiles 0,1 empty
    const selection = selectAllocation(
      ctx(stakes),
      cfg({ strategy: "k_emptiest", ladder: [usdToBase(1), usdToBase(5)], kEmptiest: 2 }),
    );
    expect(selection.kind).toBe("deploy");
    if (selection.kind !== "deploy") return;
    expect(selection.strategy).toBe("k_emptiest");
    expect(selection.totalGross).toBe(usdToBase(5)); // largest ladder ≤ cap
    expect(selection.tiles).toHaveLength(1);
    expect([0, 1]).toContain(selection.tiles[0]);
  });

  it("respects min deploy", () => {
    const selection = selectAllocation(
      ctx(chaseBoard()),
      cfg({ strategy: "k_emptiest", ladder: [usdToBase(1)], minDeploy: usdToBase(2) }),
    );
    expect(selection).toMatchObject({ kind: "skip", reason: "amount_below_min_deploy" });
  });

  it("is uniform-ish across the K emptiest under rng", () => {
    const stakes = chaseBoard();
    const rng = seededRng(1234);
    const chosen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const s = selectAllocation(
        ctx(stakes),
        cfg({ strategy: "k_emptiest", kEmptiest: 2, rng }),
      );
      if (s.kind === "deploy") chosen.add(s.tiles[0]!);
    }
    expect([...chosen].sort()).toEqual([0, 1]);
  });
});

describe("absolute EV floor (fees + opportunity)", () => {
  it("skips a round whose EV is positive but below the dollar hurdle, and fires when it clears it", async () => {
    const { selectAllocation } = await import("../src/strategy/selector.js");
    const { TILES_COUNT } = await import("../src/strategy/ev.js");
    const flat = (evPerBase: number) => ({
      predictedStakes: new Array<bigint>(TILES_COUNT).fill(0n),
      ev: (alloc: bigint[]) => Number(alloc.reduce((a, b) => a + b, 0n)) * evPerBase,
      marginal: (_a: bigint[], _t: number, inc: bigint) => Number(inc) * evPerBase,
      returns: (alloc: bigint[]) => new Array<number>(TILES_COUNT).fill(evPerBase * Number(alloc.reduce((a, b) => a + b, 0n))),
    });
    const base = { ladder: [1_000_000n], maxPerRound: 5_000_000n, minDeploy: 1_000_000n, kEmptiest: 3, strategy: "water_filling" as const };
    // +1% per $ on $5 = $0.05 of EV
    expect(selectAllocation(flat(0.01), { ...base, minEvBase: 60_000n }).kind).toBe("skip");
    expect(selectAllocation(flat(0.01), { ...base, minEvBase: 40_000n }).kind).toBe("deploy");
  });
});


describe("blanket seed (coverage non-convexity)", () => {
  /** Synthetic model: EV per base unit depends only on how many tiles are covered. */
  const coverageModel = (perBaseAt: (covered: number) => number) => {
    const total = (a: bigint[]) => a.reduce((x, y) => x + y, 0n);
    const covered = (a: bigint[]) => a.filter((x) => x > 0n).length;
    const ev = (a: bigint[]) => Number(total(a)) * perBaseAt(covered(a));
    return {
      predictedStakes: zeroStakes(),
      ev,
      marginal: (a: bigint[], t: number, inc: bigint) => {
        const after = [...a];
        after[t] = (after[t] ?? 0n) + inc;
        return ev(after) - ev(a);
      },
      returns: (a: bigint[]) => new Array<number>(TILES_COUNT).fill(ev(a)),
    };
  };
  const base = { ladder: [usdToBase(1)], minDeploy: usdToBase(1), kEmptiest: 3, strategy: "water_filling" as const, rng: seededRng(3) };

  it("reaches a positive 21-tile blanket when every lone tile is negative", () => {
    // Lone tiles −5%/$, full coverage +2%/$: the empty seed stalls at zero.
    const model = coverageModel((c) => (c === TILES_COUNT ? 0.02 : -0.05));
    const sel = selectAllocation(model, { ...base, maxPerRound: usdToBase(50) });
    expect(sel.kind).toBe("deploy");
    if (sel.kind !== "deploy") return;
    expect(sel.tiles.length).toBe(TILES_COUNT);
    expect(sel.totalGross).toBe(usdToBase(50)); // keeps filling at +2%/$ up to the cap
    expect(sel.ev).toBeCloseTo(Number(usdToBase(50)) * 0.02, 0);
    expect(sel.capBound).toBe(true);
  });

  it("still skips when the blanket is unaffordable under the cap", () => {
    const model = coverageModel((c) => (c === TILES_COUNT ? 0.02 : -0.05));
    const sel = selectAllocation(model, { ...base, maxPerRound: usdToBase(10) });
    expect(sel).toMatchObject({ kind: "skip", reason: "no_positive_marginal_ev" });
  });

  it("keeps the empty-seed result when it has the higher EV", () => {
    // Single tile +5%/$, anything wider −1%/$.
    const model = coverageModel((c) => (c === 1 ? 0.05 : -0.01));
    const sel = selectAllocation(model, { ...base, maxPerRound: usdToBase(50) });
    expect(sel.kind).toBe("deploy");
    if (sel.kind !== "deploy") return;
    expect(sel.tiles.length).toBe(1);
    expect(sel.totalGross).toBe(usdToBase(50));
  });

  it("skips when both seeds end non-positive", () => {
    const model = coverageModel(() => -0.01);
    const sel = selectAllocation(model, { ...base, maxPerRound: usdToBase(50) });
    expect(sel).toMatchObject({ kind: "skip", reason: "no_positive_marginal_ev" });
  });
});
