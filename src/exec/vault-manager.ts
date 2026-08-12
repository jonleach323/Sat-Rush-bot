/**
 * Vault manager: the polling loop + entry-timing gates that drive the
 * VaultEngine. Kept decoupled from the deploy state machine — it runs on its
 * own timer and reads chain state through an injected `readState`, so it is
 * unit-testable and, when disabled, is never even constructed (the deploy path
 * is untouched).
 *
 * Timing encodes the dev's edge — buy LATE, when the field is visible:
 * - epoch: enter only within `epochLateSlots` of the iteration window closing,
 *   so most of the field's hashrate is already committed and total_tickets is
 *   near its final (thin-or-not) value.
 * - 1-BTC: enter only once the vault is near its fill trigger, so the entrant
 *   count right before the draw is visible.
 */
import type { VaultEngine, VaultSnapshot } from "./vault-engine.js";

export interface EpochReadState {
  iterationId: number;
  open: boolean;
  totalTickets: number;
  poolValueUsd: number;
  /** Slot the current iteration opened (last trigger). */
  lastTriggerSlot: number;
  /** Iteration window length in slots (SatrushConfig). */
  iterationDurationSlots: number;
}

export interface OneBtcReadState {
  iterationId: number;
  open: boolean;
  totalTickets: number;
  poolValueUsd: number;
  /**
   * Prize actually up for grabs (base units): the vault's accrued BTC minus
   * anything already reserved for a prior winner who has not yet claimed.
   * NOT OneBtcVault.reserved_btc_amount — that field is the unclaimed-prize
   * escrow, which is 0 while a round is accumulating.
   */
  prizeBtc: number;
  /** BTC that triggers the draw (base units) — the program's 1 BTC threshold. */
  targetBtc: number;
}

export interface VaultReadState {
  slot: number;
  epoch: EpochReadState | null;
  oneBtc: OneBtcReadState | null;
}

/**
 * How wide the epoch entry window should be, in slots.
 *
 * An absolute slot count alone is a trap: mainnet iterations run for hours
 * (tens of thousands of slots), so a fixed 10-slot window is ~4 seconds wide
 * and a 5s poll simply steps over it — the vault never enters at all. Scale
 * with the iteration instead, and keep the absolute value as a floor so short
 * (devnet) iterations still get a usable window.
 */
export function epochLateWindowSlots(
  iterationDurationSlots: number,
  floorSlots: number,
  fraction: number,
): number {
  const scaled = Math.ceil(Math.max(0, iterationDurationSlots) * Math.max(0, fraction));
  return Math.max(floorSlots, scaled);
}

/**
 * Epoch entry window: open AND within `lateSlots` of the window closing.
 *
 * Past-due-but-still-Open counts. The window closing only makes the iteration
 * *eligible* for a draw; until someone cranks it, it stays Open and tickets
 * still count — and that is the single most informed moment to buy, because
 * the field is fully committed. Requiring slotsRemaining >= 0 threw that away.
 */
export function epochEntryReady(e: EpochReadState, slot: number, lateSlots: number): boolean {
  if (!e.open) return false;
  const closeSlot = e.lastTriggerSlot + e.iterationDurationSlots;
  return closeSlot - slot <= lateSlots;
}

/** Vault fill toward the draw trigger, in bps. 0 when the target is unknown. */
export function oneBtcFillBps(prizeBtc: number, targetBtc: number): number {
  if (!(targetBtc > 0)) return 0;
  return Math.round((prizeBtc / targetBtc) * 10_000);
}

/** 1-BTC entry: open AND filled to at least `minFillBps` of the trigger. */
export function oneBtcEntryReady(o: OneBtcReadState, minFillBps: number): boolean {
  if (!o.open || o.targetBtc <= 0) return false;
  return oneBtcFillBps(o.prizeBtc, o.targetBtc) >= minFillBps;
}

export interface VaultManagerOpts {
  engine: VaultEngine;
  readState: () => Promise<VaultReadState>;
  /** Absolute floor for the epoch entry window (see epochLateWindowSlots). */
  epochLateSlots: number;
  /** Fraction of the iteration to treat as "late" — the real driver on mainnet. */
  epochLateFraction: number;
  oneBtcMinFillBps: number;
  pollMs: number;
  killSwitchEngaged: () => boolean;
  /** Claim/crank pass, run after entry evaluation each tick (optional). */
  postTick?: () => Promise<void>;
  log: (obj: Record<string, unknown>) => void;
}

export class VaultManager {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: VaultManagerOpts) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    this.timer.unref?.();
    this.opts.log({ pollMs: this.opts.pollMs, msg: "vault manager started" });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One evaluation pass — public so it is directly testable. */
  async tick(): Promise<void> {
    if (this.opts.killSwitchEngaged()) return;
    let state: VaultReadState;
    try {
      state = await this.opts.readState();
    } catch (err) {
      this.opts.log({ err: String(err).slice(0, 120), msg: "vault read failed — retry next tick" });
      return;
    }

    if (
      state.epoch &&
      epochEntryReady(
        state.epoch,
        state.slot,
        epochLateWindowSlots(
          state.epoch.iterationDurationSlots,
          this.opts.epochLateSlots,
          this.opts.epochLateFraction,
        ),
      )
    ) {
      await this.evaluate("epoch", state.epoch);
    }
    if (state.oneBtc && oneBtcEntryReady(state.oneBtc, this.opts.oneBtcMinFillBps)) {
      await this.evaluate("one_btc", state.oneBtc);
    }

    // Claim/crank pass — collect resolved winnings (and crank draws if enabled).
    if (this.opts.postTick) {
      try {
        await this.opts.postTick();
      } catch (err) {
        this.opts.log({ err: String(err).slice(0, 120), msg: "vault claim/crank failed" });
      }
    }
  }

  private async evaluate(
    kind: VaultSnapshot["kind"],
    s: EpochReadState | OneBtcReadState,
  ): Promise<void> {
    try {
      await this.opts.engine.evaluate({
        kind,
        iterationId: s.iterationId,
        open: s.open,
        totalTickets: s.totalTickets,
        poolValueUsd: s.poolValueUsd,
      });
    } catch (err) {
      this.opts.log({ vault: kind, err: String(err).slice(0, 120), msg: "vault evaluate failed" });
    }
  }
}
