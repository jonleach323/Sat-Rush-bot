/**
 * Completed epoch iterations, from the public API — the field anchors for
 * EPOCH_LAST_CLOSE_TICKETS / EPOCH_LAST_CLOSE_POOL_USD and the "banked share"
 * proxy for EPOCH_FIELD_BANKED_SHARE (tickets bought in the first tenth of
 * the iteration over the total: hashrate that was already in hand when it
 * opened, and so insensitive to the iteration's own volume).
 *
 * Under V2 the 21 prizes are equal; the per-winner column checks that on the
 * iterations the API has settled.
 *
 *   pnpm epoch-history [iterations=6]
 */
const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const N = Number(process.argv[2] ?? 6);
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(20_000) })).json()) as { data: T }).data;
const usd = (n: number): string => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

interface Iter { id: number; pool_combined_usd_amount: number | null; total_participants: number; total_tickets: string; started_at: string; triggered_at: string | null; ended_at: string | null }
interface Part { authority: string; tickets: string; created_at: string; is_won: boolean | null; rank: number | null; won_combined_usd_amount: number | null }

const hist = await get<Iter[]>(`epoch/history?limit=${N + 1}`);
console.log("  iter   status    participants   tickets      pool        duration    bought in first 10%   prizes (min…max of 21)");
const closed: { id: number; tickets: number; pool: number; banked: number }[] = [];
for (const it of hist) {
  const parts = await get<Part[]>(`epoch/iterations/${it.id}/participants?limit=500`);
  const start = Date.parse(it.started_at);
  const end = it.triggered_at ? Date.parse(it.triggered_at) : Date.now();
  const tenth = start + (end - start) / 10;
  const tickets = parts.reduce((a, p) => a + Number(p.tickets), 0);
  const early = parts.filter((p) => Date.parse(p.created_at) <= tenth).reduce((a, p) => a + Number(p.tickets), 0);
  const prizes = parts.filter((p) => p.is_won && p.won_combined_usd_amount !== null).map((p) => p.won_combined_usd_amount as number);
  const days = (end - start) / 86400e3;
  const status = it.ended_at ? "closed" : "LIVE";
  const prizeCol = prizes.length ? `${usd(Math.min(...prizes))}…${usd(Math.max(...prizes))} (${prizes.length})` : "—";
  console.log(`  ${String(it.id).padStart(4)}   ${status.padEnd(8)}  ${String(it.total_participants).padStart(10)}   ${tickets.toLocaleString().padStart(9)}   ${(it.pool_combined_usd_amount === null ? "open" : usd(it.pool_combined_usd_amount)).padStart(8)}   ${days.toFixed(2).padStart(6)} d   ${(100 * early / Math.max(1, tickets)).toFixed(1).padStart(8)}%           ${prizeCol}`);
  if (it.ended_at && it.pool_combined_usd_amount !== null) closed.push({ id: it.id, tickets, pool: it.pool_combined_usd_amount, banked: early / Math.max(1, tickets) });
}
const last = closed[0];
if (last) {
  const bankedMean = closed.reduce((a, c) => a + c.banked, 0) / closed.length;
  const bankedSd = Math.sqrt(closed.reduce((a, c) => a + (c.banked - bankedMean) ** 2, 0) / Math.max(1, closed.length - 1));
  console.log(`\nEPOCH_LAST_CLOSE_TICKETS=${last.tickets}  EPOCH_LAST_CLOSE_POOL_USD=${Math.round(last.pool)}  (iteration ${last.id})`);
  console.log(`EPOCH_FIELD_BANKED_SHARE≈${bankedMean.toFixed(3)} ± ${(bankedSd / Math.sqrt(closed.length)).toFixed(3)} (first-tenth proxy over ${closed.length} closed iterations; buying is back-loaded, so this is a floor)`);
}
