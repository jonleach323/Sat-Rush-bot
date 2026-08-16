/**
 * The sats vault's exit fee, and who collects it.
 *
 * sats_vault_claim_fee_bps is 1000: a claimer receives 90% of their pro-rata
 * BTC and the other 10% stays behind. Nothing in this project priced what
 * happens to that 10% — it was treated purely as a cost on our own position.
 *
 * It is a transfer. Shares are burned on exit but the retained BTC is not, so
 * every claim raises btc_amount/btc_shares for everyone still holding. The
 * operator's remark that "LOTS of people pull sats for usdc to chase strikes"
 * is therefore a description of a subsidy: strike-chasers pay 10% to the
 * players who sit still.
 *
 * This measures both halves — that exits really do settle at exactly 0.90 of
 * the vault ratio, and how fast the ratio is drifting up as a result.
 *
 *   pnpm sats-drift
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";
import { decodeAccount, type SatrushConfig, type SatsVault } from "../src/adapter/idl.js";
import { parseCpiEventData } from "../src/ingest/events.js";
import { satrushConfigPda, satsVaultPda } from "../src/adapter/pdas.js";
import { SLOT_SECONDS as SLOT_SECONDS_FACT } from "../src/strategy/facts.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const SLOT_SECONDS = SLOT_SECONDS_FACT.value;

const vault = satsVaultPda(pid);
const sv = decodeAccount<SatsVault>("SatsVault", (await conn.getAccountInfo(vault, "confirmed"))!.data);
const conf = decodeAccount<SatrushConfig>(
  "SatrushConfig", (await conn.getAccountInfo(satrushConfigPda(pid), "confirmed"))!.data,
);
const btc = Number(sv.btc_amount.toString());
const shares = Number(sv.btc_shares.toString());
const vaultRatio = btc / shares;
console.log(`claim fee ${conf.sats_vault_claim_fee_bps} bps`);
console.log(`vault ${(btc / 1e8).toFixed(8)} BTC over ${shares.toLocaleString()} shares`);
console.log(`vault ratio ${vaultRatio.toFixed(10)} base/share\n`);

const sigs: { s: string; slot: number }[] = [];
let before: string | undefined;
for (let p = 0; p < 8; p++) {
  const res = await conn.getSignaturesForAddress(
    vault, { limit: 1000, ...(before ? { before } : {}) }, "confirmed",
  );
  if (res.length === 0) break;
  for (const x of res) if (!x.err) sigs.push({ s: x.signature, slot: x.slot });
  if (res.length < 1000) break;
  before = res[res.length - 1]?.signature;
}

const rows: { slot: number; shares: number; btc: number; hr: number }[] = [];
for (let i = 0; i < sigs.length; i += 50) {
  const txs = await conn.getTransactions(sigs.slice(i, i + 50).map((x) => x.s), {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  });
  for (const tx of txs) {
    if (!tx) continue;
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
    });
    for (const inner of tx.meta?.innerInstructions ?? []) {
      for (const ix of inner.instructions) {
        if (keys.get(ix.programIdIndex)?.toBase58() !== pid.toBase58()) continue;
        let d: Uint8Array;
        try { d = bs58.decode(ix.data); } catch { continue; }
        const e = parseCpiEventData(d, tx.slot, "");
        if (!e || e.name !== "SatsClaimed") continue;
        const dd = e.data as Record<string, { toString(): string }>;
        rows.push({
          slot: tx.slot,
          shares: Number(dd["claimed_shares"]!.toString()),
          btc: Number(dd["btc_received"]!.toString()),
          hr: Number(dd["claimed_hashrate"]!.toString()),
        });
      }
    }
  }
}
rows.sort((a, b) => a.slot - b.slot);
if (rows.length < 2) { console.log("not enough SatsClaimed events in range"); process.exit(0); }

const totS = rows.reduce((a, r) => a + r.shares, 0);
const totB = rows.reduce((a, r) => a + r.btc, 0);
const totH = rows.reduce((a, r) => a + r.hr, 0);
const spanSlots = (rows[rows.length - 1]!.slot - rows[0]!.slot) || 1;
const spanHours = (spanSlots * SLOT_SECONDS) / 3600;

console.log(`${rows.length} claims over ${spanHours.toFixed(1)}h`);
console.log(`  shares redeemed   ${totS.toLocaleString()} (${(100 * totS / shares).toFixed(2)}% of the vault)`);
console.log(`  BTC paid out      ${(totB / 1e8).toFixed(6)}`);
console.log(`  hashrate released ${(totH / 100).toLocaleString()} points`);
console.log(`  exit ratio / vault ratio = ${((totB / totS) / vaultRatio).toFixed(4)}` +
  `   (0.90 confirms the fee is retained, not paid out)\n`);

const n = Math.max(1, Math.floor(rows.length / 5));
const buckets: { slot: number; r: number }[] = [];
for (let i = 0; i + n <= rows.length; i += n) {
  const g = rows.slice(i, i + n);
  const s = g.reduce((a, x) => a + x.shares, 0);
  const b = g.reduce((a, x) => a + x.btc, 0);
  if (s > 0) buckets.push({ slot: g[0]!.slot, r: b / s });
}
console.log("  BTC per share on exit, oldest → newest:");
for (const b of buckets) console.log(`    slot ${b.slot}   ${b.r.toFixed(10)}`);

const first = buckets[0]!.r, last = buckets[buckets.length - 1]!.r;
const drift = last / first - 1;
const perDay = spanHours > 0 ? drift * (24 / spanHours) : 0;
console.log(`\n  drift over the window: ${(100 * drift).toFixed(4)}%  →  ~${(100 * perDay).toFixed(3)}%/day`);
console.log(`  cross-check: ${(100 * totS / shares).toFixed(2)}% of the vault exited paying ` +
  `${conf.sats_vault_claim_fee_bps / 100}% → holders should gain ` +
  `${(100 * (totS / shares) * (conf.sats_vault_claim_fee_bps / 10_000)).toFixed(4)}%`);
console.log(`\n  This accrues to a holder who does NOTHING. It is the only edge in this`);
console.log(`  repo that needs no deploy, no ticket, and no round won — but the rate is`);
console.log(`  set entirely by other people's exit volume, so treat it as a flow`);
console.log(`  measurement, not a yield. Re-run before relying on it.`);
