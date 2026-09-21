/**
 * Re-measure EPOCH_DEDUP_UPLIFT against the live ticket distribution.
 *
 * Epoch winners are deduped by wallet: a drawn holder's ENTIRE block leaves the
 * pool. When tickets are concentrated, whales are drawn early and vanish, so a
 * small holder's odds on later draws far exceed its raw ticket share.
 * epochWinFraction() models our own once-only constraint but treats the rest of
 * the pool as static, which understates EV by a factor that depends entirely on
 * how concentrated the field currently is.
 *
 * Reads the live iteration's participants from the public API (no RPC) and
 * simulates the 21 draws under the curve in force — V2's 21 equal slots by
 * default, V1's rank curve with `--v1` — to measure that factor. Re-run when
 * concentration shifts; the fact carries a 3-day half-life for that reason.
 *
 *   pnpm epoch-uplift [--v1] [trials=120000]
 */
import { EPOCH_EQUAL_CURVE_BPS, EPOCH_REWARD_CURVE_BPS, epochWinFraction } from "../src/strategy/vault.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const useV1 = process.argv.includes("--v1");
const trials = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 120_000);
const curve = useV1 ? EPOCH_REWARD_CURVE_BPS : EPOCH_EQUAL_CURVE_BPS;
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(20_000) })).json()) as { data: T }).data;


async function allParticipants<T extends { id: number }>(iterationId: number): Promise<T[]> {
  // Pages are newest-first; `before` walks back by entry id. Dedupe by id in
  // case a page boundary moves under us.
  const seen = new Map<number, T>();
  let before: number | undefined;
  for (let page = 0; page < 200; page++) {
    const batch = await get<T[]>(`epoch/iterations/${iterationId}/participants?limit=100${before !== undefined ? `&before=${before}` : ""}`);
    let fresh = 0;
    for (const b of batch) if (!seen.has(b.id)) { seen.set(b.id, b); fresh++; }
    if (batch.length < 100 || fresh === 0) break;
    before = Math.min(...batch.map((b) => b.id));
  }
  return [...seen.values()];
}

const hist = await get<{ id: number; total_tickets: string; total_participants: number; ended_at: string | null }[]>("epoch/history?limit=3");
const live = hist.find((h) => h.ended_at === null) ?? hist[0]!;
const parts = await allParticipants<{ id: number; authority: string; tickets: string }>(live.id);
// One block per wallet — the API lists entries; a wallet that topped up has several.
const byWallet = new Map<string, number>();
for (const p of parts) byWallet.set(p.authority, (byWallet.get(p.authority) ?? 0) + Number(p.tickets));
const field = [...byWallet.values()].filter((t) => t > 0).sort((a, b) => b - a);
const total = field.reduce((a, b) => a + b, 0);
const share = (n: number) => field.slice(0, n).reduce((a, b) => a + b, 0) / total;

console.log(`iteration ${live.id} (${useV1 ? "V1 rank curve" : "V2 equal prizes"}): ${field.length} wallets, ${total.toLocaleString()} tickets` +
  ` (API: ${live.total_participants} participants, ${Number(live.total_tickets).toLocaleString()} tickets)`);
console.log(`concentration: top1 ${(100 * share(1)).toFixed(1)}%  top10 ${(100 * share(10)).toFixed(1)}%`);

/** One draw sequence; returns the curve fraction we captured. */
function simulate(mine: number, n: number): number {
  const pool = [...field, mine];
  const me = pool.length - 1;
  let captured = 0;
  for (let t = 0; t < n; t++) {
    const alive = pool.map((_, i) => i);
    let remaining = pool.reduce((a, b) => a + b, 0);
    for (let rank = 0; rank < curve.length && remaining > 0 && alive.length > 0; rank++) {
      let r = Math.random() * remaining;
      let picked = -1;
      for (const idx of alive) {
        r -= pool[idx] as number;
        if (r < 0) { picked = idx; break; }
      }
      if (picked < 0) break;
      if (picked === me) { captured += (curve[rank] ?? 0) / 10_000; break; }
      remaining -= pool[picked] as number;
      alive.splice(alive.indexOf(picked), 1);
    }
  }
  return captured / n;
}

console.log("\n  tickets      modelled         true      uplift   (true = 21-draw simulation, whale blocks removed as drawn)");
const ratios: number[] = [];
for (const mine of [144, 500, 2000]) {
  const modelled = epochWinFraction(mine / (total + mine), 1, curve);
  const truth = simulate(mine, trials);
  const ratio = modelled > 0 ? truth / modelled : 0;
  ratios.push(ratio);
  console.log(`  ${String(mine).padStart(7)}   ${modelled.toExponential(3)}   ${truth.toExponential(3)}   ${ratio.toFixed(2)}x`);
}
const sorted = [...ratios].sort((a, b) => a - b);
const mid = sorted[Math.floor(sorted.length / 2)] as number;
// Binomial SE of the simulated capture at the mid size, propagated to the ratio.
const pMid = epochWinFraction(500 / (total + 500), 1, curve) * mid;
const se = Math.sqrt((pMid * (1 - pMid)) / trials) / (epochWinFraction(500 / (total + 500), 1, curve) || 1);
console.log(`\nEPOCH_DEDUP_UPLIFT=${mid.toFixed(2)} ± ${se.toFixed(2)} (n=${field.length} wallets, ${trials.toLocaleString()} trials)`);
console.log(`With ${field.length} wallets against 21 slots, ${(100 * Math.min(1, 21 / field.length)).toFixed(0)}% of wallets win something each draw; a small holder's odds are mostly set by the field count, not its ticket share.`);
