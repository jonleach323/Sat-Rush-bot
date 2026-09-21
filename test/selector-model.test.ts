import { describe, expect, it } from "vitest";
import { TILES_COUNT, v1Model, type EvContext } from "../src/strategy/ev.js";
import { statedV2Economics, v2Model, type V2EvContext } from "../src/strategy/ev-v2.js";
import { selectAllocation, type SelectorConfig } from "../src/strategy/selector.js";
import { usdToBase } from "../src/units.js";
import { seededRng } from "./helpers.js";

const zero = () => new Array<bigint>(TILES_COUNT).fill(0n);

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

/** Two empty tiles, $10 net on the rest (V1 fixture from selector.test.ts). */
function chaseBoard(): bigint[] {
  const stakes = zero();
  for (let i = 2; i < TILES_COUNT; i++) stakes[i] = usdToBase(10);
  return stakes;
}

describe("selector model swap", () => {
  it("a V1 context and its v1Model produce the identical selection", () => {
    const ctx: EvContext = {
      predictedStakes: chaseBoard(),
      fees: { deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000 },
      multiplier: 1,
      semantics: "raw",
    };
    for (const strategy of ["water_filling", "k_emptiest"] as const) {
      const viaCtx = selectAllocation(ctx, cfg({ strategy, rng: seededRng(11) }));
      const viaModel = selectAllocation(v1Model(ctx), cfg({ strategy, rng: seededRng(11) }));
      expect(viaModel).toEqual(viaCtx);
    }
  });

  it("under V2 the water-filler still finds the empty tiles and stops at one quantum each", () => {
    // $100 gross on 19 tiles, tiles 0 and 1 empty. Alone on an empty tile the
    // share is already 1, so a second dollar only adds its own 5% to the pool
    // at an 11% toll — negative — exactly V1's one-quantum-per-empty-tile shape.
    const stakes = zero();
    for (let i = 2; i < TILES_COUNT; i++) stakes[i] = usdToBase(94);
    const ctx: V2EvContext = { predictedStakes: stakes, econ: statedV2Economics(), mintedTokenValueBase: 0 };
    const sel = selectAllocation(v2Model(ctx), cfg());
    expect(sel.kind).toBe("deploy");
    if (sel.kind !== "deploy") return;
    expect(sel.tiles).toEqual([0, 1]);
    expect(sel.totalGross).toBe(usdToBase(2));
    expect(sel.capBound).toBe(false);
    // Two empty tiles on a ~$1,900 board: each is worth s·V/21 ≈ $4.5 for an
    // 11¢ toll.
    expect(sel.ev).toBeGreaterThan(8_000_000);
  });

  it("under V2 a uniform board with the token at nothing is declined, as under V1", () => {
    const stakes = zero().map(() => usdToBase(94));
    const ctx: V2EvContext = { predictedStakes: stakes, econ: statedV2Economics(), mintedTokenValueBase: 0 };
    const sel = selectAllocation(v2Model(ctx), cfg());
    expect(sel.kind).toBe("skip");
    if (sel.kind === "skip") expect(sel.reason).toBe("no_positive_marginal_ev");
  });

  it("under V2 a rich enough token mint makes presence itself worth it on a uniform board", () => {
    // 21 × $100 board, $500 of RUSH minted: 80% of it comes back pro-rata, so
    // a dollar earns ~$0.19 of RUSH against a 6¢ toll and the filler deploys
    // up to the cap.
    const stakes = zero().map(() => usdToBase(94));
    const ctx: V2EvContext = {
      predictedStakes: stakes, econ: statedV2Economics(), mintedTokenValueBase: Number(usdToBase(500)),
    };
    const sel = selectAllocation(v2Model(ctx), cfg({ maxPerRound: usdToBase(20) }));
    expect(sel.kind).toBe("deploy");
    if (sel.kind !== "deploy") return;
    expect(sel.totalGross).toBe(usdToBase(20));
    expect(sel.capBound).toBe(true);
  });

  it("k_emptiest runs against a V2 model", () => {
    const stakes = zero();
    for (let i = 2; i < TILES_COUNT; i++) stakes[i] = usdToBase(94);
    const ctx: V2EvContext = { predictedStakes: stakes, econ: statedV2Economics(), mintedTokenValueBase: 0 };
    const sel = selectAllocation(v2Model(ctx), cfg({ strategy: "k_emptiest", kEmptiest: 2 }));
    expect(sel.kind).toBe("deploy");
    if (sel.kind !== "deploy") return;
    expect([0, 1]).toContain(sel.tiles[0]);
    expect(sel.totalGross).toBe(usdToBase(1));
  });
});
