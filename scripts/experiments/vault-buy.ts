/**
 * Live devnet validation of the epoch-vault ticket path: read the open
 * iteration, buy a few tickets, and confirm (a) the builder lands and (b) the
 * hashrate cost per ticket (validates the assumed 1 point = 1 ticket). Sends
 * real devnet transactions — EXECUTION_MODE=devnet required.
 */
import {
  decodeAccount,
  type EpochVault,
  type EpochVaultEntry,
  type EpochVaultIteration,
  type Miner,
} from "../../src/adapter/idl.js";
import { buildBuyEpochTickets } from "../../src/adapter/instructions.js";
import {
  epochVaultEntryPda,
  epochVaultIterationPda,
  epochVaultPda,
  minerPda,
} from "../../src/adapter/pdas.js";
import { explorer, sendIxs, setupExperiment } from "./lib.js";

const TICKETS = 5n;
const x = await setupExperiment("vault-buy");

const readMinerHashrate = async (): Promise<bigint> => {
  const info = await x.conn.getAccountInfo(minerPda(x.payer.publicKey, x.programId), "confirmed");
  if (!info) throw new Error("miner not found");
  return BigInt(decodeAccount<Miner>("Miner", info.data).hashrate_amount.toString());
};

const evInfo = await x.conn.getAccountInfo(epochVaultPda(x.programId), "confirmed");
const ev = decodeAccount<EpochVault>("EpochVault", evInfo!.data);
const iterationId = ev.iteration_id;

const readIter = async (): Promise<EpochVaultIteration> => {
  const info = await x.conn.getAccountInfo(
    epochVaultIterationPda(iterationId, x.programId),
    "confirmed",
  );
  return decodeAccount<EpochVaultIteration>("EpochVaultIteration", info!.data);
};

const before = await readIter();
const hrBefore = await readMinerHashrate();
x.log(
  `epoch iteration ${iterationId}: state=${Object.keys(before.state)[0]} ` +
    `total_tickets=${before.total_tickets.toString()} pool_usd=${ev.pool_usd_amount.toString()}`,
);
x.log(`hashrate before: ${hrBefore}; buying ${TICKETS} tickets on page 0`);

const ix = buildBuyEpochTickets(x.ixCtx, {
  authority: x.payer.publicKey,
  iterationId,
  pageIndex: 0,
  ticketsToBuy: TICKETS,
});
const sent = await sendIxs(x, x.payer, [ix]);
x.log(`tx ${sent.err ? "FAILED" : "landed"}: ${explorer(sent.sig)}`);
if (sent.err) {
  x.log(`error: ${sent.err}`);
  for (const l of sent.logs.slice(-12)) x.log(`  log: ${l}`);
  process.exit(1);
}

const hrAfter = await readMinerHashrate();
const after = await readIter();
const entryInfo = await x.conn.getAccountInfo(
  epochVaultEntryPda(iterationId, x.payer.publicKey, x.programId),
  "confirmed",
);
const entry = entryInfo
  ? decodeAccount<EpochVaultEntry>("EpochVaultEntry", entryInfo.data)
  : null;

const hrSpent = hrBefore - hrAfter;
x.log(`hashrate after: ${hrAfter} (spent ${hrSpent} for ${TICKETS} tickets)`);
x.log(`cost per ticket: ${Number(hrSpent) / Number(TICKETS)} hashrate/ticket`);
x.log(`our entry tickets: ${entry ? entry.tickets.toString() : "NONE"}`);
x.log(`iteration total_tickets: ${before.total_tickets.toString()} → ${after.total_tickets.toString()}`);
x.log(
  hrSpent === TICKETS
    ? "✓ 1:1 hashrate→ticket confirmed"
    : `⚠ cost is ${Number(hrSpent) / Number(TICKETS)}:1, not 1:1 — update the EV model`,
);
