/**
 * pnpm fleet:init [size=FLEET_SIZE|21] [tag=AFFILIATE_TAG]
 *
 * Creates the fleet the bot loads when WALLET_PATHS is empty: wallet-02.json …
 * wallet-<size>.json under FLEET_DIR (the primary, KEYPAIR_PATH, is wallet 1).
 * Idempotent — existing files are kept, never overwritten. Files are written
 * 0600 and no secret ever reaches stdout. Then, in mainnet mode, registers the
 * primary's affiliate tag (`set_miner_tag`) if it has none, so every extra
 * wallet binds to it at its first deploy and its volume rebates 10 bps of
 * the protocol leg as grubstake on the primary.
 *
 * After this: send USDC and SOL to the PRIMARY. The treasury distributes.
 */
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { loadKeypair, assembleTx } from "../src/exec/tx.js";
import { WalletSet } from "../src/exec/wallets.js";
import { buildSetMinerTag } from "../src/adapter/instructions.js";
import { affiliatePda, satrushConfigPda } from "../src/adapter/pdas.js";
import { decodeAccount } from "../src/adapter/idl.js";
import type { SatrushConfig } from "../src/adapter/generated-types.js";
import { PublicKey } from "@solana/web3.js";

const cfg = loadConfig();
const size = Number(process.argv[2] ?? cfg.FLEET_SIZE ?? 21);
const tag = process.argv[3] ?? cfg.AFFILIATE_TAG;
if (!Number.isInteger(size) || size < 1 || size > 64) throw new Error(`fleet size must be 1–64, got ${process.argv[2]}`);

const primary = loadKeypair(cfg.KEYPAIR_PATH);
const created = WalletSet.ensureFleet({ dir: cfg.FLEET_DIR, size });
const set = WalletSet.load([], cfg.KEYPAIR_PATH, { dir: cfg.FLEET_DIR, size });
console.log(`fleet: ${set.size} wallets (${created} created, ${set.size - 1 - created} existing) in ${cfg.FLEET_DIR}`);
set.pubkeys().forEach((k, i) => console.log(`  ${String(i + 1).padStart(2)}  tile ${String((i % 21) + 1).padStart(2)}  ${k.toBase58()}${i === 0 ? "  ← primary: deposit USDC + SOL here" : ""}`));
console.log(`\nset FLEET_SIZE=${size} in .env (WALLET_PATHS stays empty). Tile mode maps wallet i → tile i.`);

// ── affiliate tag on the primary ────────────────────────────────────────────
const connection = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const programId = new PublicKey(cfg.PROGRAM_ID);
const affInfo = await connection.getAccountInfo(affiliatePda(primary.publicKey, programId));
if (affInfo) {
  console.log(`\naffiliate: the primary already has an Affiliate account — extras will bind to it at their first deploy.`);
} else if (!tag) {
  console.log(`\naffiliate: NOT registered and no tag given — pass one (pnpm fleet:init ${size} <tag>) or set AFFILIATE_TAG; extras earn no rebate until then.`);
} else if (cfg.EXECUTION_MODE !== "mainnet") {
  console.log(`\naffiliate: would register tag "${tag}" for the primary (EXECUTION_MODE=${cfg.EXECUTION_MODE}; set mainnet + MAINNET_CONFIRM=yes to send).`);
} else {
  const confInfo = await connection.getAccountInfo(satrushConfigPda(programId));
  if (!confInfo) throw new Error("SatrushConfig not found on this RPC");
  const conf = decodeAccount<SatrushConfig>("SatrushConfig", confInfo.data);
  const ixCtx = { usdMint: conf.usd_mint, btcMint: conf.btc_mint, tokenMint: conf.token_mint, programId };
  const ix = buildSetMinerTag(ixCtx, { authority: primary.publicKey, tag });
  const { tx } = await assembleTx(connection, { payer: primary, instructions: [ix], computeUnitLimit: 200_000, priorityFeeMicroLamports: 1_000 });
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log(`\naffiliate: set_miner_tag("${tag}") sent — ${sig}`);
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`affiliate: confirmed. Extras bind to ${primary.publicKey.toBase58()} at their first deploy.`);
}
