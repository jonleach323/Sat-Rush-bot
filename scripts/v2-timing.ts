/**
 * pnpm v2-timing [rounds=120]
 *
 * Rival timing and automation inflow on live V2 rounds, from the API: when
 * rivals deploy relative to the round's end (seconds before settle), what
 * share of gross is automation, how much of the final board is already on
 * the table at various points, and how many deploys land in the last 10 s.
 * These are the V1-calibrated inputs to the occupancy prediction
 * (AUTOMATION_FIRE_RATE, ENDGAME_CONVERGENCE) re-read on V2.
 */
const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const N = Number(process.argv[2] ?? 120);
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(20_000) })).json()) as { data: T }).data;
interface Dep { deployed_at: string; deployed_usd_amount: string; is_automation: boolean; is_grubstake_funded: boolean; selected_tiles: number }
interface Round { id: number; started_at: string; settled_at: string | null; total_gross_deployed_usd: string; miners_count: number; deployments?: Dep[] }
const board = await get<{ round_id: number; round_duration: number }>("board");
const rows: { id: number; gross: number; autoShare: number; n: number; lateN: number; at: number[]; amt: number[]; auto: boolean[]; tiles: number[]; grub: number }[] = [];
for (let id = board.round_id - 2; id > board.round_id - 2 - N; id--) {
  let r: Round & { round?: Round };
  try { r = await get(`rounds/${id}`); } catch { continue; }
  const x = (r.round ?? r) as Round;
  const ds = r.deployments ?? x.deployments ?? [];
  if (!x.settled_at || ds.length === 0) continue;
  // Round length is start→start of the next; use the board's duration at ~0.4 s/slot.
  const start = Date.parse(x.started_at);
  const end = start + board.round_duration * 400;
  const amt = ds.map((d) => Number(d.deployed_usd_amount) / 1e6);
  const gross = amt.reduce((a, b) => a + b, 0);
  const auto = ds.map((d) => d.is_automation);
  const autoUsd = ds.reduce((a, d, i) => a + (d.is_automation ? amt[i]! : 0), 0);
  const at = ds.map((d) => (end - Date.parse(d.deployed_at)) / 1000); // seconds before cutoff
  rows.push({ id, gross, autoShare: gross > 0 ? autoUsd / gross : 0, n: ds.length, lateN: at.filter((s) => s <= 10).length, at, amt, auto,
    tiles: ds.map((d) => { let n = 0; for (let i = 0; i < 21; i++) if (d.selected_tiles & (1 << i)) n++; return n; }),
    grub: ds.filter((d) => d.is_grubstake_funded).length });
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(`${rows.length} rounds ${rows[rows.length - 1]?.id}…${rows[0]?.id} · round ${board.round_duration} slots ≈ ${(board.round_duration * 0.4).toFixed(0)} s`);
console.log(`gross/round $${mean(rows.map((r) => r.gross)).toFixed(0)} · deploys/round ${mean(rows.map((r) => r.n)).toFixed(1)} · automation share of gross ${pct(mean(rows.map((r) => r.autoShare)))} · grubstake-funded deploys/round ${mean(rows.map((r) => r.grub)).toFixed(2)}`);
// Fraction of final gross on the table at t seconds before cutoff (pooled).
console.log("\n  seconds before cutoff   share of final gross already deployed   deploys after this point");
for (const s of [60, 40, 30, 20, 15, 10, 8, 6, 4, 2]) {
  const shares = rows.map((r) => { let g = 0; r.at.forEach((t, i) => { if (t >= s) g += r.amt[i]!; }); return r.gross > 0 ? g / r.gross : 0; });
  const after = rows.map((r) => r.at.filter((t) => t < s).length);
  console.log(`  ${String(s).padStart(6)} s                ${pct(mean(shares)).padStart(8)}                              ${mean(after).toFixed(2)}`);
}
const manual = rows.flatMap((r) => r.at.filter((_, i) => !r.auto[i]));
const autos = rows.flatMap((r) => r.at.filter((_, i) => r.auto[i]));
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))] ?? 0; };
console.log(`\nautomations deploy ${q(autos, 0.5).toFixed(0)} s before cutoff (median; 10th–90th ${q(autos, 0.1).toFixed(0)}–${q(autos, 0.9).toFixed(0)} s) — at round open when the crank fires`);
console.log(`manual deploys       ${q(manual, 0.5).toFixed(0)} s before cutoff (median; 10th–90th ${q(manual, 0.1).toFixed(0)}–${q(manual, 0.9).toFixed(0)} s); ${pct(manual.filter((t) => t <= 10).length / Math.max(1, manual.length))} of them inside the last 10 s`);
const tilesAll = rows.flatMap((r) => r.tiles.map((t, i) => [t, r.amt[i]!] as const));
const blanket = tilesAll.filter(([t]) => t === 21).reduce((a, [, v]) => a + v, 0) / Math.max(1e-9, tilesAll.reduce((a, [, v]) => a + v, 0));
console.log(`all-21-tile deploys carry ${pct(blanket)} of gross; single-tile deploys ${pct(tilesAll.filter(([t]) => t === 1).length / Math.max(1, tilesAll.length))} of deploys`);
