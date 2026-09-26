/**
 * Alert tiers. Telegram got hundreds of pushes a day because routine
 * operation — a fleet round with 18/21 legs in, a USD compound claim, a
 * ticket buy — was sent like an incident. Routine events are NOTED here and
 * summarised in a periodic digest (and /digest); only incidents push. A
 * routine event that recurs past a rate escalates to one push, then
 * cools down. Pure: the orchestrator decides what is urgent and sends.
 */

export type NoteKind =
  | "fleet_partial"
  | "compound_claim"
  | "vault_buy"
  | "cap_bound"
  | "missed_round"
  | "deploy_failed"
  | "settle_sweep_failed"
  | "ramp";

interface KindTally {
  count: number;
  usd: number;
  last: string;
}

export interface FleetLegTally {
  rounds: number;
  legsSent: number;
  legsLanded: number;
  /** Missed or failed legs per wallet (short id). */
  missesByWallet: Map<string, number>;
}

export class Digest {
  private kinds = new Map<NoteKind, KindTally>();
  private fleet: FleetLegTally = { rounds: 0, legsSent: 0, legsLanded: 0, missesByWallet: new Map() };
  private since: number;
  /** Rolling window of fleet rounds for escalation: landed fraction per round. */
  private recentRounds: number[] = [];

  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
  }

  note(kind: NoteKind, text: string, usd = 0): void {
    const t = this.kinds.get(kind) ?? { count: 0, usd: 0, last: "" };
    t.count++;
    t.usd += usd;
    t.last = text;
    this.kinds.set(kind, t);
  }

  /** One fleet round's leg outcomes. Returns the landed fraction over the recent window. */
  fleetRound(sent: number, landed: number, missedWallets: string[], window = 10): number {
    this.fleet.rounds++;
    this.fleet.legsSent += sent;
    this.fleet.legsLanded += landed;
    for (const w of missedWallets) this.fleet.missesByWallet.set(w, (this.fleet.missesByWallet.get(w) ?? 0) + 1);
    this.recentRounds.push(sent > 0 ? landed / sent : 1);
    if (this.recentRounds.length > window) this.recentRounds.shift();
    return this.recentRounds.reduce((a, b) => a + b, 0) / this.recentRounds.length;
  }

  /** Recent fleet rounds recorded (for "enough evidence to escalate"). */
  recentFleetRounds(): number {
    return this.recentRounds.length;
  }

  isEmpty(): boolean {
    return this.kinds.size === 0 && this.fleet.rounds === 0;
  }

  /** Render and reset. */
  flush(title = "🗒 digest"): string | null {
    if (this.isEmpty()) {
      this.since = this.now();
      return null;
    }
    const hours = Math.max(0.1, (this.now() - this.since) / 3_600_000);
    const lines = [`${title} · last ${hours.toFixed(1)} h`];
    const f = this.fleet;
    if (f.rounds > 0) {
      const pct = f.legsSent > 0 ? (100 * f.legsLanded) / f.legsSent : 100;
      lines.push(`fleet: ${f.rounds} rounds · ${f.legsLanded}/${f.legsSent} legs landed (${pct.toFixed(1)}%)`);
      const worst = [...f.missesByWallet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (worst.length > 0) lines.push(`  most missed: ${worst.map(([w, n]) => `${w}×${n}`).join(" ")}`);
    }
    const label: Record<NoteKind, string> = {
      fleet_partial: "partial fleet rounds",
      compound_claim: "USD compound claims",
      vault_buy: "vault ticket buys",
      cap_bound: "cap-bound rounds",
      missed_round: "missed rounds",
      deploy_failed: "failed deploys",
      settle_sweep_failed: "settle sweep failures",
      ramp: "ramp signal changes",
    };
    for (const [kind, t] of this.kinds) {
      lines.push(`${label[kind]}: ${t.count}${t.usd !== 0 ? ` · $${t.usd.toFixed(2)}` : ""}`);
    }
    this.kinds = new Map();
    this.fleet = { rounds: 0, legsSent: 0, legsLanded: 0, missesByWallet: new Map() };
    this.since = this.now();
    return lines.join("\n");
  }
}

/** Per-key push cooldown: the same incident pushes at most once per window. */
export class AlertThrottle {
  private last = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  allow(key: string, cooldownMs: number): boolean {
    const t = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < cooldownMs) return false;
    this.last.set(key, t);
    return true;
  }
}
