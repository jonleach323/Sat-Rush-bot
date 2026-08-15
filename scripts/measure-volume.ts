/**
 * Ground-truth game volume and epoch-pool history — measured, not extrapolated.
 *
 * Every volume figure in this project so far has been inferred from an
 * aggregate (a pool size, a dashboard total, a sampled window) and every one of
 * them has been wrong. This reads the primary records instead:
 *
 *   - the last N Round accounts, summing deployed_usd_amount directly;
 *   - every past EpochVaultIteration, for what each pool ACTUALLY closed at.
 *
 * Those two together pin the epoch channel's real size without extrapolating
 * from a partially-elapsed window.
 *
 *   pnpm measure-volume [rounds]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import {
  decodeAccount,
  type Board,
  type EpochVault,
  type EpochVaultIteration,
  type SatrushConfig,
} from "../src/adapter/idl.js";
import {
  boardPda,
  epochVaultIterationPda,
  epochVaultPda,
  roundPda,
  satrushConfigPda,
} from "../src/adapter/pdas.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const num = (v: { toString(): string }): number => Number(v.toString());
const usd = (n: number): string => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const SAMPLE = Number(process.argv[2] ?? 300);

async function decodeAt<T>(name: string, key: PublicKey): Promise<T | null> {
  const info = await conn.getAccountInfo(key, "confirmed");
  return info ? decodeAccount<T>(name, info.data) : null;
}

const conf = await decodeAt<SatrushConfig>("SatrushConfig", satrushConfigPda(pid));
const board = await decodeAt<Board>("Board", boardPda(pid));
const ev = await decodeAt<EpochVault>("EpochVault", epochVaultPda(pid));
if (!conf || !board || !ev) throw new Error("core accounts unavailable");

// ── measured per-round volume ────────────────────────────────────────────────
const head = board.round_id;
const ids: number[] = [];
for (let i = 1; i <= SAMPLE; i++) if (head - i > 0) ids.push(head - i);

const rounds: { id: number; usd: number; miners: number }[] = [];
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const infos = await conn.getMultipleAccountsInfo(
    chunk.map((id) => roundPda(id, pid)),
    "confirmed",
  );
  infos.forEach((info, j) => {
    if (!info) return; // settled rounds have their rent reclaimed — expected
    const r = decodeAccount<Record<string, never>>("Round", info.data) as unknown as {
      deployed_usd_amount: { toString(): string };
      miners_count: number;
    };
    rounds.push({
      id: chunk[j] as number,
      usd: num(r.deployed_usd_amount) / 1e6,
      miners: r.miners_count,
    });
  });
}

rounds.sort((a, b) => a.id - b.id);
const live = rounds.filter((r) => r.usd > 0);
const totalUsd = live.reduce((a, r) => a + r.usd, 0);
const mean = live.length ? totalUsd / live.length : 0;
const sorted = [...live].map((r) => r.usd).sort((a, b) => a - b);
const median = sorted.length ? (sorted[Math.floor(sorted.length / 2)] as number) : 0;
const roundSeconds = board.round_duration * 0.4;
const roundsPerDay = 86_400 / roundSeconds;

console.log("═══ measured round volume ═══");
console.log(`  head round        ${head}`);
console.log(`  readable rounds   ${rounds.length} of ${ids.length} sampled (rest settled + rent-reclaimed)`);
console.log(`  non-empty rounds  ${live.length}`);
console.log(`  mean   ${usd(mean)}/round     median ${usd(median)}/round`);
console.log(`  miners ${live.length ? (live.reduce((a, r) => a + r.miners, 0) / live.length).toFixed(1) : 0} avg/round`);
console.log(`  round duration ${board.round_duration} slots ≈ ${roundSeconds.toFixed(0)}s → ${roundsPerDay.toFixed(0)} rounds/day`);
console.log(`\n  → DAILY VOLUME  ${usd(mean * roundsPerDay)}`);
console.log(`  → per 3-day epoch iteration ${usd(mean * roundsPerDay * 3)}`);
console.log(`  → implied epoch inflow @ ${conf.epoch_fee_bps} bps: ${usd(mean * roundsPerDay * 3 * (conf.epoch_fee_bps / 10_000))}`);
console.log(`  → implied 1-BTC inflow @ ${conf.one_btc_fee_bps} bps: ${usd(mean * roundsPerDay * (conf.one_btc_fee_bps / 10_000))}/day`);

// ── epoch pool history: what iterations ACTUALLY closed at ───────────────────
console.log("\n═══ epoch iteration history (measured, not extrapolated) ═══");
const its = await conn.getMultipleAccountsInfo(
  Array.from({ length: ev.iteration_id + 1 }, (_, i) => epochVaultIterationPda(i, pid)),
  "confirmed",
);
console.log("  iter   state       tickets   wallets   claimable USD   claimable BTC");
its.forEach((info, i) => {
  if (!info) return;
  const it = decodeAccount<EpochVaultIteration>("EpochVaultIteration", info.data);
  const state = Object.keys(it.state)[0] ?? "?";
  console.log(
    `  ${String(i).padStart(4)}   ${state.padEnd(9)}   ${num(it.total_tickets).toLocaleString().padStart(8)}   ` +
      `${String(it.participants_count).padStart(7)}   ${usd(num(it.claimable_usd) / 1e6).padStart(13)}   ` +
      `${(num(it.claimable_btc) / 1e8).toFixed(6)}`,
  );
});
console.log(`\n  current pool_usd ${usd(num(ev.pool_usd_amount) / 1e6)}  pool_btc ${(num(ev.pool_btc_amount) / 1e8).toFixed(6)}`);
console.log(`  pending_usd ${usd(num(ev.pending_usd_amount) / 1e6)}  reserved_usd ${usd(num(ev.reserved_usd_amount) / 1e6)}`);
