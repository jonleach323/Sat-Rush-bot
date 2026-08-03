/**
 * Vault engine: decision + GATED execution for the hashrate raffles, sitting on
 * top of the pure selector (strategy/vault.ts). It is deliberately decoupled
 * from the orchestrator — all I/O (current hashrate, our held tickets, the buy
 * itself) is injected, so it is unit-testable and touches no live send path of
 * its own.
 *
 * Safety gates, in order: the master enable flag (default off) → the iteration
 * must be open → a per-iteration latch (never buy the same draw twice) → a
 * positive-EV ticket decision → dry-mode short-circuit (decide + log, never
 * send). A real buy happens ONLY when enabled && !dry && the decision is
 * positive; the injected `buy` is what the orchestrator points at the live
 * sender (after the 1:1 hashrate-cost validation).
 */
import {
  buildVaultContext,
  selectVaultTickets,
  type VaultDecision,
  type VaultKind,
} from "../strategy/vault.js";

export interface VaultSnapshot {
  kind: VaultKind;
  iterationId: number;
  /** True while the iteration still accepts ticket purchases (state Open). */
  open: boolean;
  /** iteration.total_tickets (everyone, including us). */
  totalTickets: number;
  /** Prize pool in USD (BTC valued at the estimate; epoch adds pool USD). */
  poolValueUsd: number;
}

export interface VaultEngineOpts {
  enabled: boolean;
  dry: boolean;
  /** Opportunity value of one hashrate POINT, in USD (pickiness floor). */
  hashrateValueUsd: number;
  /** Program cost of one ticket in hashrate points (measured devnet = 100). */
  ticketPriceHashrate: number;
  maxTickets: number;
  /** Fraction of claimable hashrate this strategy may spend (0..1). */
  hashrateFraction: number;
  /** Claimable hashrate points available right now. */
  hashrateAvailable: () => number;
  /** Tickets we already hold in (kind, iterationId); 0 if none. */
  myTickets: (kind: VaultKind, iterationId: number) => number;
  /** Execute a real buy; returns a signature. Called ONLY when enabled && !dry. */
  buy: (kind: VaultKind, iterationId: number, tickets: number) => Promise<string>;
  log: (obj: Record<string, unknown>) => void;
}

export interface VaultEvalResult {
  decision: VaultDecision | null;
  /** A live buy was sent. */
  acted: boolean;
  /** Signature when a live buy landed. */
  signature: string | null;
  /** Why we did not send (null when acted). */
  skipped: string | null;
}

export class VaultEngine {
  /** Per-iteration latch: `${kind}:${iterationId}` we have already played. */
  private readonly played = new Set<string>();

  constructor(private readonly opts: VaultEngineOpts) {}

  private key(kind: VaultKind, iterationId: number): string {
    return `${kind}:${iterationId}`;
  }

  /** Mirror the deploy latch recovery: re-arm from persisted state on boot. */
  markPlayed(kind: VaultKind, iterationId: number): void {
    this.played.add(this.key(kind, iterationId));
  }

  hasPlayed(kind: VaultKind, iterationId: number): boolean {
    return this.played.has(this.key(kind, iterationId));
  }

  async evaluate(snap: VaultSnapshot): Promise<VaultEvalResult> {
    const none = (skipped: string): VaultEvalResult => ({
      decision: null,
      acted: false,
      signature: null,
      skipped,
    });

    if (!this.opts.enabled) return none("disabled");
    if (!snap.open) return none("iteration_not_open");
    if (this.hasPlayed(snap.kind, snap.iterationId)) return none("already_played");

    const spendablePoints = this.opts.hashrateAvailable() * this.opts.hashrateFraction;
    const decision = selectVaultTickets(
      buildVaultContext({
        kind: snap.kind,
        poolValueUsd: snap.poolValueUsd,
        totalTickets: snap.totalTickets,
        myTickets: this.opts.myTickets(snap.kind, snap.iterationId),
        hashratePointsAvailable: spendablePoints,
        ticketPriceHashrate: this.opts.ticketPriceHashrate,
        hashrateValueUsdPerPoint: this.opts.hashrateValueUsd,
        maxTickets: this.opts.maxTickets,
      }),
    );

    if (decision.tickets <= 0) {
      return { decision, acted: false, signature: null, skipped: decision.reason };
    }

    if (this.opts.dry) {
      this.opts.log({
        vault: snap.kind,
        iteration: snap.iterationId,
        dryWouldBuy: decision.tickets,
        evUsd: decision.evUsd,
        winShareAfter: decision.winShareAfter,
        msg: "vault: dry — would buy tickets",
      });
      return { decision, acted: false, signature: null, skipped: "dry" };
    }

    // Live: latch BEFORE awaiting the send so a slow confirm can't double-fire.
    this.played.add(this.key(snap.kind, snap.iterationId));
    const signature = await this.opts.buy(snap.kind, snap.iterationId, decision.tickets);
    this.opts.log({
      vault: snap.kind,
      iteration: snap.iterationId,
      boughtTickets: decision.tickets,
      evUsd: decision.evUsd,
      winShareAfter: decision.winShareAfter,
      signature,
      msg: "vault: bought tickets",
    });
    return { decision, acted: true, signature, skipped: null };
  }
}
