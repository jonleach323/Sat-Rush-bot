/**
 * pnpm mint-rule [rounds=400] [step=25]
 *
 * Which rule does the mint follow: a FIXED amount per round (so thin rounds
 * pay more RUSH per dollar, and the bot — which sees the round's volume at
 * cutoff — should fire into them), or a fixed RATE per dollar (so timing is
 * worthless)? Regress minted RUSH on gross volume across sampled settled
 * rounds from the public API. Under a fixed amount the slope is ~0 and the
 * per-round mint is flat; under a fixed rate the intercept is ~0 and the
 * ratio is flat. Reports both fits, the ratio's dependence on volume, and
 * the drift of the rate over time (the owner says it decreases).
 */
const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const N = Number(process.argv[2] ?? 400);
const STEP = Number(process.argv[3] ?? 25);
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(20_000) })).json()) as { data: T }).data;
const board = await get<{ round_id: number }>("board");
interface R { id: number; state: string; total_gross_deployed_usd: string; minted_token: string; settled_at: string | null; miners_count: number }
const rows: { id: number; v: number; m: number; at: number }[] = [];
for (let id = board.round_id - 3; id > board.round_id - N * STEP && rows.length < N; id -= STEP) {
  let r: R & { round?: R };
  try { r = await get(`rounds/${id}`); } catch { continue; }
  const x = (r.round ?? r) as R;
  const v = Number(x.total_gross_deployed_usd) / 1e6, m = Number(x.minted_token) / 1e9;
  if (!(v > 0) || !(m > 0) || !x.settled_at) continue;
  rows.push({ id, v, m, at: Date.parse(x.settled_at) });
}
rows.sort((a, b) => a.id - b.id);
const n = rows.length;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const V = rows.map((r) => r.v), M = rows.map((r) => r.m), Y = rows.map((r) => r.m / r.v);
const fit = (xs: number[], ys: number[]) => {
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += (xs[i]! - mx) ** 2; sxy += (xs[i]! - mx) * (ys[i]! - my); syy += (ys[i]! - my) ** 2; }
  const b = sxy / sxx, a = my - b * mx, r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  const resid = ys.map((y, i) => y - a - b * xs[i]!);
  const se = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / (xs.length - 2) / sxx);
  return { a, b, r2, seB: se };
};
const fm = fit(V, M);          // M = a + b·V   (fixed amount ⇒ b≈0; fixed rate ⇒ a≈0)
const fy = fit(V, Y);          // ratio vs volume (fixed rate ⇒ slope≈0; fixed amount ⇒ ratio ∝ 1/V)
const ft = fit(rows.map((r) => (r.at - rows[0]!.at) / 86400e3), Y.map((y) => y * 1000)); // rate drift per day
const cv = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2))) / mean(xs);
console.log(`${n} settled rounds, ${rows[0]!.id}…${rows[n - 1]!.id} (${((rows[n - 1]!.at - rows[0]!.at) / 86400e3).toFixed(1)} d)`);
console.log(`gross/round   mean $${mean(V).toFixed(0)}  CV ${(100 * cv(V)).toFixed(0)}%   |   RUSH/round mean ${mean(M).toFixed(4)}  CV ${(100 * cv(M)).toFixed(0)}%   |   RUSH per $1k mean ${(1000 * mean(Y)).toFixed(4)}  CV ${(100 * cv(Y)).toFixed(0)}%`);
console.log(`M = a + b·V:   a = ${fm.a.toFixed(4)} RUSH, b = ${(1000 * fm.b).toFixed(4)} ± ${(1000 * fm.seB).toFixed(4)} RUSH per $1k, R² ${fm.r2.toFixed(3)}`);
console.log(`ratio vs V:    slope ${(1e6 * fy.b).toExponential(2)} ± ${(1e6 * fy.seB).toExponential(2)} RUSH/$ per $1k of volume, R² ${fy.r2.toFixed(3)}`);
console.log(`rate drift:    ${ft.b >= 0 ? "+" : ""}${ft.b.toFixed(5)} ± ${ft.seB.toFixed(5)} RUSH per $1k per day (${((100 * ft.b) / (1000 * mean(Y))).toFixed(2)}%/day of the mean)`);
const verdict = fm.r2 > 0.8 && Math.abs(fm.a) < 0.2 * mean(M) ? "FIXED RATE per dollar: the mint scales with volume; timing thin rounds buys nothing"
  : fm.r2 < 0.2 && cv(M) < 0.5 * cv(V) ? "FIXED AMOUNT per round: thin rounds pay more per dollar; the selector should use the round's own volume"
  : "MIXED: neither rule fits cleanly — see the fits above";
console.log(`verdict: ${verdict}`);
// Bucketed view: ratio by volume tercile.
const byV = [...rows].sort((a, b) => a.v - b.v);
for (const [label, part] of [["thin third", byV.slice(0, n / 3)], ["middle third", byV.slice(n / 3, (2 * n) / 3)], ["fat third", byV.slice((2 * n) / 3)]] as const) {
  console.log(`  ${label.padEnd(13)} gross $${mean(part.map((r) => r.v)).toFixed(0).padStart(5)}  RUSH/round ${mean(part.map((r) => r.m)).toFixed(4)}  RUSH per $1k ${(1000 * mean(part.map((r) => r.m / r.v))).toFixed(4)}`);
}
