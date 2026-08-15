/**
 * Settle rent: who collects it, and how much is on the table.
 *
 * settle_deploy_public is permissionless and takes a `rent_recipient` account
 * separate from the signer. This project assumed that meant the rent went back
 * to the depositor and that self-settling was merely about immediacy. It does
 * not — the cranker keeps it, which makes settling other people's deployments
 * a standing bounty rather than a chore.
 *
 * Measured from balance deltas on real settle transactions: the fee payer ends
 * each one NET POSITIVE by ~0.0017 SOL, consistent with the rent-exempt
 * minimum of a ~270-byte PublicDeployment account less the signature fee.
 *
 * Two things worth keeping straight before acting on it. This is a bounty for
 * work the game needs done — unsettled deployments never pay their owners out
 * — so it is value-additive when the field is under-served, and a latency race
 * against whoever else wants it when it is not. And the crank currently
 * collecting is the operator's own, so competing head-on is a relationship
 * question, not just an engineering one.
 *
 *   pnpm settle-rent [rounds]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";
import { decodeAccount, type Board } from "../src/adapter/idl.js";
import { parseCpiEventData } from "../src/ingest/events.js";
import { boardPda, roundPda } from "../src/adapter/pdas.js";
import { PriceFeed } from "../src/ingest/prices.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const ROUNDS = Number(process.argv[2] ?? 12);

const board = decodeAccount<Board>("Board", (await conn.getAccountInfo(boardPda(pid), "confirmed"))!.data);
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
const SOL = prices.solUsd();

const ids = Array.from({ length: ROUNDS }, (_, i) => board.round_id - 4 - i).filter((x) => x > 0);
const sigs: string[] = [];
for (const id of ids) {
  const res = await conn.getSignaturesForAddress(roundPda(id, pid), { limit: 1000 }, "confirmed");
  for (const x of res) if (!x.err) sigs.push(x.signature);
}

const byPayer = new Map<string, { settles: number; net: number; txs: number }>();
for (let i = 0; i < sigs.length; i += 50) {
  const txs = await conn.getTransactions(sigs.slice(i, i + 50), {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  });
  for (const tx of txs) {
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses ?? null,
    });
    let settled = 0;
    for (const inner of tx.meta.innerInstructions ?? []) {
      for (const ix of inner.instructions) {
        if (keys.get(ix.programIdIndex)?.toBase58() !== pid.toBase58()) continue;
        let d: Uint8Array;
        try { d = bs58.decode(ix.data); } catch { continue; }
        if (parseCpiEventData(d, tx.slot, "")?.name === "PublicDeploySettled") settled++;
      }
    }
    if (settled === 0) continue;
    const payer = keys.get(0)!.toBase58();
    const net = (tx.meta.postBalances[0]! - tx.meta.preBalances[0]!) / 1e9;
    const cur = byPayer.get(payer) ?? { settles: 0, net: 0, txs: 0 };
    byPayer.set(payer, { settles: cur.settles + settled, net: cur.net + net, txs: cur.txs + 1 });
  }
}

const total = [...byPayer.values()].reduce(
  (a, v) => ({ settles: a.settles + v.settles, net: a.net + v.net, txs: a.txs + v.txs }),
  { settles: 0, net: 0, txs: 0 },
);
if (total.settles === 0) { console.log("no settles in range"); process.exit(0); }

console.log(`${ids.length} rounds · ${total.txs} settle transactions · ${total.settles} deployments settled`);
console.log(`SOL $${SOL.toFixed(2)}\n`);
console.log("  cranker                                        settles    net SOL    per settle");
for (const [k, v] of [...byPayer.entries()].sort((a, b) => b[1].settles - a[1].settles).slice(0, 10)) {
  console.log(`  ${k}  ${String(v.settles).padStart(7)}  ${(v.net >= 0 ? "+" : "") + v.net.toFixed(6)}   ` +
    `${(v.net >= 0 ? "+" : "") + (v.net / v.settles).toFixed(6)}`);
}

const perSettle = total.net / total.settles;
const perRound = total.settles / ids.length;
const perDay = perRound * 1440;
console.log(`\n  net per settled deployment: ${(perSettle >= 0 ? "+" : "") + perSettle.toFixed(6)} SOL = $${(perSettle * SOL).toFixed(4)}`);
console.log(`  deployments settled per round: ${perRound.toFixed(1)}`);
console.log(`  → whole-game rent flow: ${(perDay * perSettle).toFixed(1)} SOL/day = $${(perDay * perSettle * SOL).toLocaleString(undefined, { maximumFractionDigits: 0 })}/day`);
console.log(`\n  ${byPayer.size === 1 ? "ONE cranker is taking all of it — uncontested." : `${byPayer.size} crankers are splitting it.`}`);
console.log(`  We already keep our own via SELF_SETTLE. This is the rest of the field's.`);
