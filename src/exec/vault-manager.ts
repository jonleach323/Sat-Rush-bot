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
  /** Current accumulated BTC (base units). */
  btcAmount: number;
  /** BTC needed to trigger a draw (base units). */
  reservedBtc: number;
}

export interface VaultReadState {
  slot: number;
  epoch: EpochReadState | null;
  oneBtc: OneBtcReadState | null;
}

/** Epoch entry window: open AND within `lateSlots` of the window closing. */
export function epochEntryReady(e: EpochReadState, slot: number, lateSlots: number): boolean {
  if (!e.open) return false;
  const closeSlot = e.lastTriggerSlot + e.iterationDurationSlots;
  const slotsRemaining = closeSlot - slot;
  return slotsRemaining >= 0 && slotsRemaining <= lateSlots;
}

/** 1-BTC entry: open AND filled to at least `minFillBps` of the trigger. */
export function oneBtcEntryReady(o: OneBtcReadState, minFillBps: number): boolean {
  if (!o.open || o.reservedBtc <= 0) return false;
  return (o.btcAmount / o.reservedBtc) * 10_000 >= minFillBps;
}

export interface VaultManagerOpts {
  engine: VaultEngine;
  readState: () => Promise<VaultReadState>;
  epochLateSlots: number;
  oneBtcMinFillBps: number;
  pollMs: number;
  killSwitchEngaged: () => boolean;
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

    if (state.epoch && epochEntryReady(state.epoch, state.slot, this.opts.epochLateSlots)) {
      await this.evaluate("epoch", state.epoch);
    }
    if (state.oneBtc && oneBtcEntryReady(state.oneBtc, this.opts.oneBtcMinFillBps)) {
      await this.evaluate("one_btc", state.oneBtc);
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
