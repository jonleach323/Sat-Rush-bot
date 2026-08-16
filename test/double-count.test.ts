import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  automationInflow,
  maskTiles,
  pendingCommitments,
  type AutomationCommitment,
} from "../src/ingest/automations.js";
import { evOfAllocation, TILES_COUNT, type EvContext } from "../src/strategy/ev.js";
import { predictFinalOccupancy } from "../src/strategy/predict.js";

/**
 * Regression tests for the input error that made the live bot fire losing
 * trades and log them as winners.
 *
 * `visibleStakes()` reads Round.public_tile_stakes — the program's own state —
 * and the crank executes every funded automation at ROUND OPEN. So the board
 * already contains that money by the time we evaluate near cutoff, and adding
 * the whole automation book on top counted 86% of the field twice.
 *
 * MEASURED consequence, over 60 single-tile deploys with the board split at our
 * own landing slot: our chosen tile sat at 99.38% +/- 0.11% of the board
 * average at fire time — a losing pick, since break-even is 90.9% — while the
 * model priced it near 68% and logged a +26% edge. Only 0.16% of the board
 * landed after us, so there was no future inflow to predict at all.
 */
const ALL = (1 << TILES_COUNT) - 1;
const commit = (mask: number, perRoundUsd: number): AutomationCommitment => ({
  authority: Keypair.generate().publicKey,
  tiles: maskTiles(mask),
  perRoundBase: BigInt(perRoundUsd * 1e6),
  remainingBase: BigInt(perRoundUsd * 1e6 * 100),
  reload: true,
});
const flat = (usd: number): bigint[] =>
  new Array<bigint>(TILES_COUNT).fill(BigInt(Math.round(usd * 1e6)));

describe("pendingCommitments removes automations that already fired", () => {
  const a = commit(ALL, 3), b = commit(ALL, 3), c = commit(0b1111111, 7);
  const book = [a, b, c];

  it("keeps everything when nothing has deployed", () => {
    expect(pendingCommitments(book, new Set())).toHaveLength(3);
  });

  it("drops exactly the ones seen deploying", () => {
    const seen = new Set([a.authority.toBase58(), c.authority.toBase58()]);
    expect(pendingCommitments(book, seen).map((x) => x.authority.toBase58()))
      .toEqual([b.authority.toBase58()]);
  });

  it("predicts nothing once the whole book has fired — the live case at cutoff", () => {
    const seen = new Set(book.map((x) => x.authority.toBase58()));
    expect(pendingCommitments(book, seen)).toEqual([]);
    expect(automationInflow(pendingCommitments(book, seen),
      { netFactor: 0.92, fireRate: 1 }).every((x) => x === 0n)).toBe(true);
  });

  it("is unaffected by unrelated wallets deploying", () => {
    const seen = new Set([Keypair.generate().publicKey.toBase58()]);
    expect(pendingCommitments(book, seen)).toHaveLength(3);
  });
});

describe("the double count is what made a fair tile look cheap", () => {
  // A uniform board of $3.20/tile — the live shape. Nothing here is a bargain.
  const board = flat(3.2);
  // 33 blanket automations plus one 7-tile mask, as measured on mainnet. The
  // uneven mask is what tilts the board when it is counted twice.
  const book = [commit(ALL, 99), commit(0b1111111, 7)];
  const inflow = automationInflow(book, { netFactor: 0.92, fireRate: 1 });

  const ctxFor = (stakes: bigint[]): EvContext => ({
    predictedStakes: stakes, fees: {
      deployFeeBps: 800, satsVaultRoundBps: 1200, satsVaultClaimBps: 1000,
    }, multiplier: 1, semantics: "raw",
  });
  const alloc = (tile: number, usd: number): bigint[] => {
    const a = new Array<bigint>(TILES_COUNT).fill(0n);
    a[tile] = BigInt(usd * 1e6);
    return a;
  };
  /** A tile the 7-tile mask does NOT cover — the one that looks cheap. */
  const UNCOVERED = 20;

  it("double counting invents an edge on a tile that has none", () => {
    const honest = predictFinalOccupancy({
      visibleStakes: board, hiddenPoolEstimate: 0n,
      elapsedSlots: 146, remainingSlots: 4, expectedAutomationInflow: null,
    });
    const doubled = predictFinalOccupancy({
      visibleStakes: board, hiddenPoolEstimate: 0n,
      elapsedSlots: 146, remainingSlots: 4, expectedAutomationInflow: inflow,
    });
    const bet = alloc(UNCOVERED, 2);
    // On the real board the deploy is a loser...
    expect(evOfAllocation(ctxFor(honest.stakes), bet)).toBeLessThan(0);
    // ...and counting the book twice turns it into a winner.
    expect(evOfAllocation(ctxFor(doubled.stakes), bet)).toBeGreaterThan(
      evOfAllocation(ctxFor(honest.stakes), bet),
    );
  });

  it("over-predicting rivals is NOT conservative — it inflates the pot too", () => {
    // The trap that hid this for so long. Adding rival money raises the payout
    // as well as the dilution, so a too-large inflow raises modelled EV.
    const bet = alloc(UNCOVERED, 2);
    const none = predictFinalOccupancy({
      visibleStakes: board, hiddenPoolEstimate: 0n,
      elapsedSlots: 146, remainingSlots: 4, expectedAutomationInflow: null,
    });
    const lots = predictFinalOccupancy({
      visibleStakes: board, hiddenPoolEstimate: 0n,
      elapsedSlots: 146, remainingSlots: 4,
      expectedAutomationInflow: automationInflow(
        [commit(ALL, 500), commit(0b1111111, 200)], { netFactor: 0.92, fireRate: 1 },
      ),
    });
    expect(evOfAllocation(ctxFor(lots.stakes), bet))
      .toBeGreaterThan(evOfAllocation(ctxFor(none.stakes), bet));
  });

  it("a blanket-only book tilts nothing — only uneven masks do", () => {
    const blanketOnly = automationInflow([commit(ALL, 99)], { netFactor: 0.92, fireRate: 1 });
    expect(new Set(blanketOnly.map(String)).size).toBe(1);
    // With the 7-tile mask in the book the uncovered tiles get strictly less.
    expect(inflow[UNCOVERED]!).toBeLessThan(inflow[0]!);
  });

  it("with the book correctly emptied, the prediction is the board itself", () => {
    const seen = new Set(book.map((b) => b.authority.toBase58()));
    const p = predictFinalOccupancy({
      visibleStakes: board, hiddenPoolEstimate: 0n,
      elapsedSlots: 146, remainingSlots: 4,
      expectedAutomationInflow: automationInflow(
        pendingCommitments(book, seen), { netFactor: 0.92, fireRate: 1 },
      ),
    });
    // Only the guarded fill-rate extrapolation remains, which at 4 remaining
    // slots of 150 is small and — being proportional — tilts nothing.
    const ratio = p.stakes.map((s) => Number(s) / Number(board[0]!));
    expect(Math.max(...ratio) - Math.min(...ratio)).toBeLessThan(1e-6);
  });
});
