/**
 * Create the settle-crank address lookup table.
 *
 * Every account an ALT covers costs ONE byte in a transaction message instead
 * of thirty-two, and message size is what caps how many settles fit in a
 * batch. The incumbent crank packs 2.86 per transaction; batching is worth at
 * least as much as latency in a first-to-land race, so this is the cheapest
 * throughput available.
 *
 * The non-obvious part is which accounts are worth including. A settle touches
 * five accounts per deployment beyond the shared set:
 *
 *   rent_recipient      us — constant
 *   miner               PDA of the deploying AUTHORITY — stable across rounds
 *   public_automation   PDA of the authority — stable across rounds
 *   automation_usd_ata  derived from the automation — stable across rounds
 *   public_deployment   PDA of (authority, ROUND) — changes every round
 *
 * Only the last one actually varies. The same wallets deploy round after
 * round, so putting the recurring authorities' three stable PDAs in the table
 * leaves a single 32-byte account per settle instead of four — which is the
 * difference between packing ~8 and packing ~25.
 *
 * Costs a little rent (refundable by closing the table) and one transaction
 * per 20 addresses. Run once; put the printed address in SETTLE_ALT_ADDRESS.
 *
 *   pnpm create-alt            # dry run: shows what would go in
 *   pnpm create-alt --commit   # actually creates it
 */
import {
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";
import { decodeAccount, type Board, type SatrushConfig } from "../src/adapter/idl.js";
import { parseCpiEventData } from "../src/ingest/events.js";
import {
  boardPda,
  boardBtcAta,
  boardUsdAta,
  minerPda,
  publicAutomationPda,
  roundPda,
  satrushConfigPda,
  satsVaultBtcAta,
  satsVaultPda,
} from "../src/adapter/pdas.js";
import { eventAuthorityPda } from "../src/adapter/instructions.js";
import { loadKeypair } from "../src/exec/tx.js";

const COMMIT = process.argv.includes("--commit");
const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const payer = loadKeypair(cfg.KEYPAIR_PATH);

const conf = decodeAccount<SatrushConfig>(
  "SatrushConfig", (await conn.getAccountInfo(satrushConfigPda(pid), "confirmed"))!.data);
const board = decodeAccount<Board>("Board", (await conn.getAccountInfo(boardPda(pid), "confirmed"))!.data);

// ── the shared set, identical on every settle ────────────────────────────────
const shared: PublicKey[] = [
  payer.publicKey,                       // authority AND rent_recipient
  satrushConfigPda(pid),
  boardPda(pid),
  satsVaultPda(pid),
  conf.btc_mint,
  conf.usd_mint,
  boardUsdAta(conf.usd_mint, pid),
  boardBtcAta(conf.btc_mint, pid),
  satsVaultBtcAta(conf.btc_mint, pid),
  eventAuthorityPda(pid),
  pid,
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  new PublicKey("11111111111111111111111111111111"),
];

// ── recurring deploy authorities, from recent rounds ─────────────────────────
const LOOKBACK = 12;
const ids = Array.from({ length: LOOKBACK }, (_, i) => board.round_id - 3 - i).filter((x) => x > 0);
const seen = new Map<string, number>();
for (const id of ids) {
  const res = await conn.getSignaturesForAddress(roundPda(id, pid), { limit: 1000 }, "confirmed");
  const txs = await conn.getTransactions(res.filter((x) => !x.err).map((x) => x.signature), {
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
        if (e?.name !== "PublicDeployCreated") continue;
        const who = String((e.data as Record<string, unknown>)["authority"]);
        seen.set(who, (seen.get(who) ?? 0) + 1);
      }
    }
  }
}

// Only wallets that show up often enough to be worth a slot. A one-off deploy
// costs three table entries and saves 96 bytes exactly once.
const MIN_APPEARANCES = Math.max(2, Math.floor(LOOKBACK * 0.5));
const recurring = [...seen.entries()]
  .filter(([, n]) => n >= MIN_APPEARANCES)
  .sort((a, b) => b[1] - a[1])
  .map(([k]) => new PublicKey(k));

const perAuthority: PublicKey[] = [];
for (const a of recurring) {
  const automation = publicAutomationPda(a, pid);
  perAuthority.push(minerPda(a, pid), automation, getAssociatedTokenAddressSync(conf.usd_mint, automation, true));
}

// 256 is the hard cap on a lookup table.
const addresses = [...shared, ...perAuthority].slice(0, 256);
console.log(`shared accounts:        ${shared.length}`);
console.log(`recurring authorities:  ${recurring.length} of ${seen.size} seen over ${ids.length} rounds`);
console.log(`  (appearing in >= ${MIN_APPEARANCES} rounds)`);
console.log(`per-authority entries:  ${perAuthority.length}`);
console.log(`TOTAL:                  ${addresses.length} / 256\n`);

const covered = recurring.length;
console.log(`With this table a settle costs 32 bytes (public_deployment) for a covered`);
console.log(`authority, against 128 without it. Uncovered authorities still cost 128.`);
console.log(`Coverage of recent deploys: ${((100 * [...seen.entries()].filter(([k]) => recurring.some((r) => r.toBase58() === k)).reduce((a, [, n]) => a + n, 0)) / [...seen.values()].reduce((a, b) => a + b, 0)).toFixed(1)}%\n`);

if (!COMMIT) {
  console.log("DRY RUN — nothing sent. Re-run with --commit to create the table.");
  console.log(`Rent is roughly ${(0.00089 + addresses.length * 0.00000073).toFixed(5)} SOL, refundable by closing it.`);
  process.exit(0);
}

// ── create + extend ──────────────────────────────────────────────────────────
const slot = await conn.getSlot("finalized");
const [createIx, table] = AddressLookupTableProgram.createLookupTable({
  authority: payer.publicKey,
  payer: payer.publicKey,
  recentSlot: slot,
});
console.log(`creating ${table.toBase58()} …`);

async function sendIxs(instructions: TransactionInstruction[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash, instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

console.log(`  create: ${await sendIxs([createIx])}`);

// 20 addresses per transaction keeps the message comfortably inside the limit.
for (let i = 0; i < addresses.length; i += 20) {
  const chunk = addresses.slice(i, i + 20);
  const ix = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: table,
    addresses: chunk,
  });
  console.log(`  extend ${i}–${i + chunk.length - 1}: ${await sendIxs([ix])}`);
}

console.log(`\nDONE. Put this in .env:`);
console.log(`  SETTLE_ALT_ADDRESS=${table.toBase58()}`);
console.log(`\nA table is only usable one slot after the extend that added an address,`);
console.log(`so give it a few seconds before restarting the bot. Re-run this script`);
console.log(`when the set of recurring authorities drifts — coverage decays as the`);
console.log(`field turns over, and an uncovered authority silently costs 4x the bytes.`);
console.log(`${covered} authorities covered.`);
