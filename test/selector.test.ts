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
