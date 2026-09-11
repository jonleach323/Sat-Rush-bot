/**
 * Has epoch farming earned the right to be switched on?
 *
 * HASHRATE_DEPLOY_CREDIT_ENABLED is off because farming is unproven, and the
 * bar written into that config is specific: one full iteration where the epoch
 * take, against the pool that ACTUALLY CLOSED, exceeds the board cost of the
 * deploys that earned it. This is the thing that checks it.
 *
 * It is deliberately backward-looking and refuses to score an unpaid
 * iteration. Every wrong answer in this project came from projecting one side
 * of that comparison from a partly-elapsed window — the pool at 7% elapsed,
 * the field extrapolated linearly, the hashrate multiplier assumed. A verdict
 * that can be reached before the draw resolves is the same mistake with a
 * different label.
 *
 *   pnpm farming-verdict
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../../src/config.js";
import { StateDb } from "../../src/state/db.js";
import { decodeAccount, type Board, type EpochVault, type SatrushConfig, type SatsVault }
  from "../../src/adapter/idl.js";
import { boardPda, epochVaultPda, satrushConfigPda, satsVaultPda } from "../../src/adapter/pdas.js";
import { PriceFeed } from "../../src/ingest/prices.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const db = new StateDb(cfg.DB_PATH);
const num = (v: { toString(): string }): number => Number(v.toString());
const usd = (base: bigint): string => `$${(Number(base) / 1e6).toFixed(2)}`;

const conf = decodeAccount<SatrushConfig>(
  "SatrushConfig", (await conn.getAccountInfo(satrushConfigPda(pid), "confirmed"))!.data);
const board = decodeAccount<Board>("Board", (await conn.getAccountInfo(boardPda(pid), "confirmed"))!.data);
const ev = decodeAccount<EpochVault>("EpochVault", (await conn.getAccountInfo(epochVaultPda(pid), "confirmed"))!.data);
const sv = decodeAccount<SatsVault>("SatsVault", (await conn.getAccountInfo(satsVaultPda(pid), "confirmed"))!.data);

const prices = new PriceFeed({
  connection: conn,
  accounts: {
    btc: cfg.PYTH_BTC_USD_ACCOUNT ? new PublicKey(cfg.PYTH_BTC_USD_ACCOUNT) : undefined,
    sol: cfg.PYTH_SOL_USD_ACCOUNT ? new PublicKey(cfg.PYTH_SOL_USD_ACCOUNT) : undefined,
  },
  fallback: { btc: cfg.BTC_USD_ESTIMATE, sol: cfg.SOL_USD_ESTIMATE },
  log: () => {},
});
await prices.refresh();

// Value a share the way we could actually realise it: net of the claim fee.
const shares = num(sv.btc_shares);
const shareUsd = shares > 0
  ? (num(sv.btc_amount) / shares / 1e8) * prices.btcUsd() * (1 - conf.vault_exit_fee_bps / 10_000)
  : 0;

const iterSlots = num(conf.epoch_vault_iteration_duration);
const roundsPerIter = Math.round(iterSlots / Math.max(1, board.round_duration));
const head = board.round_id;

console.log(`gate: HASHRATE_DEPLOY_CREDIT_ENABLED = ${cfg.HASHRATE_DEPLOY_CREDIT_ENABLED}`);
console.log(`live iteration ${ev.iteration_id} · ${roundsPerIter} rounds per iteration`);
console.log(`share value ${shareUsd.toExponential(3)} USD (net of the ${conf.vault_exit_fee_bps / 100}% claim fee)\n`);

let anyPaid = false;
console.log("  iter   deploys   deployed    board back   epoch paid    NET      verdict");
for (let back = 1; back <= 4; back++) {
  const iterationId = ev.iteration_id - back;
  if (iterationId < 0) break;
  // Rounds covered by that iteration, walking back from the live one.
  const toRound = head - (back - 1) * roundsPerIter - 1;
  const fromRound = toRound - roundsPerIter + 1;
  const v = db.farmingVerdict(iterationId, Math.max(1, fromRound), toRound);

  if (!v.claimed) {
    console.log(`  ${String(iterationId).padStart(4)}   ${String(v.deploys).padStart(7)}   ` +
      `${usd(v.deployedUsd).padStart(9)}   ${"—".padStart(10)}   ${"unpaid".padStart(10)}   ` +
      `${"—".padStart(8)}   no claim recorded — cannot score`);
    continue;
  }
  anyPaid = true;
  const boardBack = Number(v.wonUsd) / 1e6 + Number(v.wonShares) * shareUsd;
  const deployed = Number(v.deployedUsd) / 1e6;
  const epochPaid = Number(v.epochUsd) / 1e6 + (Number(v.epochBtc) / 1e8) * prices.btcUsd();
  const net = boardBack - deployed + epochPaid;
  console.log(
    `  ${String(iterationId).padStart(4)}   ${String(v.deploys).padStart(7)}   ` +
      `$${deployed.toFixed(2).padStart(8)}   $${boardBack.toFixed(2).padStart(9)}   ` +
      `$${epochPaid.toFixed(2).padStart(9)}   ${(net >= 0 ? "+" : "-") + "$" + Math.abs(net).toFixed(2)}   ` +
      (net > 0 ? "CLEARS" : "does not clear"),
  );
}

console.log();
if (!anyPaid) {
  console.log("  No completed, claimed iteration to score yet.");
  console.log("  The gate stays shut — not because farming failed, but because");
  console.log("  nothing has been measured. Run again after an epoch claim lands.");
} else {
  console.log("  A single clearing iteration is weak evidence: the epoch payout is a");
  console.log("  21-winner draw, so one iteration is one sample of a lumpy variable.");
  console.log("  Two or three consecutive clears is the honest bar for flipping the gate.");
}
db.close();
