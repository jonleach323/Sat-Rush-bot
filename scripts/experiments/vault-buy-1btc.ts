/**
 * Live devnet validation of the 1-BTC ticket path: exercises the fresh
 * ticket-keypair signer (distinct from the epoch entry-PDA path) and measures
 * its hashrate cost per ticket. Sends real devnet txs — EXECUTION_MODE=devnet.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  decodeAccount,
  type Miner,
  type OneBtcVault,
  type OneBtcVaultIteration,
} from "../../src/adapter/idl.js";
import { buildBuyOneBtcTickets } from "../../src/adapter/instructions.js";
import { minerPda, oneBtcVaultIterationPda, oneBtcVaultPda } from "../../src/adapter/pdas.js";
import { assembleTx } from "../../src/exec/tx.js";
import { explorer, sendIxs, setupExperiment } from "./lib.js";

const TICKETS = 2n;
const x = await setupExperiment("vault-buy-1btc");

const hashrate = async (): Promise<bigint> => {
  const info = await x.conn.getAccountInfo(minerPda(x.payer.publicKey, x.programId), "confirmed");
  return BigInt(decodeAccount<Miner>("Miner", info!.data).hashrate_amount.toString());
};

const vInfo = await x.conn.getAccountInfo(oneBtcVaultPda(x.programId), "confirmed");
const v = decodeAccount<OneBtcVault>("OneBtcVault", vInfo!.data);
const iterationId = v.iteration_id;
const itInfo = await x.conn.getAccountInfo(
  oneBtcVaultIterationPda(iterationId, x.programId),
  "confirmed",
);
const it = decodeAccount<OneBtcVaultIteration>("OneBtcVaultIteration", itInfo!.data);
x.log(
  `1-BTC iteration ${iterationId}: state=${Object.keys(it.state)[0]} ` +
    `total_tickets=${it.total_tickets.toString()} btc_amount=${v.btc_amount.toString()}`,
);

const hrBefore = await hashrate();
const ticket = Keypair.generate();
x.log(`hashrate before: ${hrBefore}; buying ${TICKETS} tickets (ticket ${ticket.publicKey.toBase58()})`);

const ix = buildBuyOneBtcTickets(x.ixCtx, {
  authority: x.payer.publicKey,
  iterationId,
  ticket: ticket.publicKey,
  ticketsToBuy: TICKETS,
});
// Two signers: the payer AND the fresh ticket account being init'd.
const assembled = await assembleTx(x.conn, {
  payer: x.payer,
  instructions: [ix],
  computeUnitLimit: 400_000,
  priorityFeeMicroLamports: 1_000,
});
assembled.tx.sign([ticket]);
const serialized = Buffer.from(assembled.tx.serialize());
const sig = bs58.encode(assembled.tx.signatures[0]!);

const sent = await sendIxs(x, x.payer, [], { presigned: { serialized, sig } });
x.log(`tx ${sent.err ? "FAILED" : "landed"}: ${explorer(sent.sig)}`);
if (sent.err) {
  x.log(`error: ${sent.err}`);
  for (const l of sent.logs.slice(-12)) x.log(`  log: ${l}`);
  process.exit(1);
}

const hrAfter = await hashrate();
const spent = hrBefore - hrAfter;
x.log(`hashrate after: ${hrAfter} (spent ${spent} for ${TICKETS} tickets)`);
x.log(`cost per ticket: ${Number(spent) / Number(TICKETS)} hashrate/ticket`);
