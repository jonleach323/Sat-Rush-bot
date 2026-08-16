/**
 * What hashrate do we actually hold, and does VAULT_MAX_TICKETS bind?
 *
 * The cap governs a different decision than farming does. Farming asks whether
 * to DEPLOY in order to earn hashrate — that pays the blanket toll and is the
 * thing measured as negative. This asks whether to SPEND hashrate already
 * earned, which is sunk and has exactly one sink, so the cap can only ever
 * forfeit value, never protect capital.
 *
 * Whether that matters is empirical: a cap above our balance is inert.
 *
 *   pnpm hashrate-balance
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { decodeAccount, type Board, type Miner, type SatrushConfig } from "../src/adapter/idl.js";
import { boardPda, minerPda, satrushConfigPda } from "../src/adapter/pdas.js";
import { PriceFeed } from "../src/ingest/prices.js";
import { readEpochField } from "../src/ingest/epoch-field.js";
import { hashrateRawPerUsd, REWARD_MAX_STREAK } from "../src/strategy/hashrate.js";
import { TILES_COUNT } from "../src/strategy/ev.js";
import { VAULT_HASHRATE_PER_TICKET } from "../src/strategy/facts.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const n = (v: unknown): number => Number((v as { toString(): string }).toString());
const TICKET_PRICE_RAW = VAULT_HASHRATE_PER_TICKET.value;

// An explicit pubkey argument checks any wallet; with none, the configured
// keypair. Reporting which one was used is the point — a KEYPAIR_PATH that
// resolves to a different wallet than the operator expects is worth seeing.
let authority: PublicKey;
try {
  authority = process.argv[2]
    ? new PublicKey(process.argv[2])
    : Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(readFileSync(cfg.KEYPAIR_PATH, "utf8")) as number[]),
      ).publicKey;
} catch {
  console.log(`cannot read KEYPAIR_PATH (${cfg.KEYPAIR_PATH}) — reporting the cap only`);
  console.log(`VAULT_MAX_TICKETS = ${cfg.VAULT_MAX_TICKETS}`);
  process.exit(0);
}

const [confI, boardI, minerI, slot] = await Promise.all([
  conn.getAccountInfo(satrushConfigPda(pid), "confirmed"),
  conn.getAccountInfo(boardPda(pid), "confirmed"),
  conn.getAccountInfo(minerPda(authority, pid), "confirmed"),
  conn.getSlot("confirmed"),
]);
const conf = decodeAccount<SatrushConfig>("SatrushConfig", confI!.data);
const board = decodeAccount<Board>("Board", boardI!.data);

console.log(`wallet ${authority.toBase58()}` +
  `${process.argv[2] ? "" : ` (from KEYPAIR_PATH ${cfg.KEYPAIR_PATH})`}`);
if (!minerI) {
  console.log(`\nNo Miner account exists — this wallet has never deployed.`);
  console.log(`Hashrate balance is 0, so VAULT_MAX_TICKETS (${cfg.VAULT_MAX_TICKETS}) is inert:`);
  console.log(`it cannot throttle a spend of something we do not have.`);
} else {
  const m = decodeAccount<Miner>("Miner", minerI.data);
  const raw = n(m.hashrate_amount);
  const unclaimed = n(m.unclaimed_hashrate);
  console.log(`\nMiner account:`);
  console.log(`  hashrate_amount     ${raw.toLocaleString()} raw = ` +
    `${Math.floor(raw / TICKET_PRICE_RAW).toLocaleString()} tickets`);
  console.log(`  unclaimed_hashrate  ${unclaimed.toLocaleString()} raw`);
  console.log(`  current_streak      ${n(m.current_streak_count)}`);
  console.log(`  last_mined_round    ${n(m.last_mined_round_id)} (board is at ${board.round_id})`);

  const spendable = Math.floor((raw * cfg.VAULT_HASHRATE_FRACTION) / TICKET_PRICE_RAW);
  console.log(`\n  spendable at VAULT_HASHRATE_FRACTION=${cfg.VAULT_HASHRATE_FRACTION}: ` +
    `${spendable.toLocaleString()} tickets`);
  console.log(`  VAULT_MAX_TICKETS = ${cfg.VAULT_MAX_TICKETS} → ` +
    (spendable > cfg.VAULT_MAX_TICKETS
      ? `BINDING, forfeiting ${(spendable - cfg.VAULT_MAX_TICKETS).toLocaleString()} tickets`
      : `inert (below our balance)`));
}

// What each strategy would earn, so the cap can be judged against a rate rather
// than a snapshot.
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
const field = await readEpochField({
  connection: conn, programId: pid, btcUsd: prices.btcUsd(),
  iterationSlots: n(conf.epoch_vault_iteration_duration), slot,
});
const roundsPerIter = Math.round(
  n(conf.epoch_vault_iteration_duration) / Math.max(1, board.round_duration));

console.log(`\nearn rate per iteration (${roundsPerIter.toLocaleString()} rounds), $1/round:`);
for (const [label, rounds, tiles, streak] of [
  ["snipe (fires ~1 in 400)", roundsPerIter / 400, 1, 1],
  ["present every round, blanket", roundsPerIter, TILES_COUNT, REWARD_MAX_STREAK],
  ["present every round, 1 tile", roundsPerIter, 1, REWARD_MAX_STREAK],
] as [string, number, number, number][]) {
  const tickets = Math.floor((rounds * hashrateRawPerUsd(streak, tiles)) / TICKET_PRICE_RAW);
  console.log(`  ${label.padEnd(30)} ${tickets.toLocaleString().padStart(8)} tickets   ` +
    (tickets > cfg.VAULT_MAX_TICKETS ? "cap BINDS" : "cap inert"));
}
console.log(`\nlive field ${field.totalTickets.toLocaleString()} tickets / ${field.participants} wallets;` +
  ` VAULT_MAX_SHARE=${cfg.VAULT_MAX_SHARE} would allow far more than ${cfg.VAULT_MAX_TICKETS}.`);
console.log(`The two caps answer different questions: MAX_SHARE bounds what a ticket`);
console.log(`is WORTH (dilution), MAX_TICKETS bounds how many we BUY (blast radius).`);
