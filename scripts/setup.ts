/**
 * pnpm setup [--mainnet] [--wait]
 *
 * The whole first run in one command:
 *   1. writes .env from .env.example if there is none (FLEET_SIZE=21; with
 *      --mainnet also EXECUTION_MODE=mainnet + MAINNET_CONFIRM=yes — that is
 *      the send gate, so it is only ever set because you asked);
 *   2. creates the primary keypair and the 20 fleet wallets (0600, never printed);
 *   3. checks the RPC and decodes the live SatrushConfig;
 *   4. prints the ONE deposit address, the minimum first deposit, and QR codes
 *      (Solana Pay: scan with Phantom / Solflare / Backpack) for USDC and SOL;
 *   5. with --wait, polls until the deposit lands, then tells you to start.
 * Re-runnable; never overwrites a key or an existing .env value.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { loadConfig } from "../src/config.js";
import { loadKeypair } from "../src/exec/tx.js";
import { WalletSet } from "../src/exec/wallets.js";
import { depositInfo, qrAscii } from "../src/ops/deposit.js";
import { readSatrushConfig } from "./lib/onchain.js";

const args = new Set(process.argv.slice(2));
const mainnet = args.has("--mainnet"), wait = args.has("--wait");

// 1. .env
if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("wrote .env from .env.example");
}
let env = readFileSync(".env", "utf8");
const setKey = (k: string, v: string) => {
  const re = new RegExp(`^#?\\s*${k}=.*$`, "m");
  env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + `\n${k}=${v}\n`;
};
setKey("FLEET_SIZE", process.env["FLEET_SIZE"] ?? "21");
if (mainnet) { setKey("EXECUTION_MODE", "mainnet"); setKey("MAINNET_CONFIRM", "yes"); }
writeFileSync(".env", env);
for (const [k, v] of env.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split(/=(.*)/s))) if (v !== undefined && v !== "") process.env[k!] ??= v;
const cfg = loadConfig();

// 2. keys
if (WalletSet.ensurePrimary(cfg.KEYPAIR_PATH)) console.log(`created the primary keypair at ${cfg.KEYPAIR_PATH}`);
const created = WalletSet.ensureFleet({ dir: cfg.FLEET_DIR, size: cfg.FLEET_SIZE });
const set = WalletSet.load([], cfg.KEYPAIR_PATH, { dir: cfg.FLEET_DIR, size: cfg.FLEET_SIZE });
console.log(`fleet: ${set.size} wallets (${created} created) under ${cfg.FLEET_DIR}`);
const primary = loadKeypair(cfg.KEYPAIR_PATH).publicKey;

// 3. chain
const connection = new Connection(cfg.RPC_HTTP_URL, "confirmed");
let usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
try {
  const slot = await connection.getSlot();
  const conf = await readSatrushConfig(cfg.RPC_HTTP_URL);
  if (conf) usdcMint = conf.usd_mint.toBase58();
  console.log(`rpc ok (slot ${slot}) · SatrushConfig ${conf ? "decoded (fees " + conf.strike_fee_bps + "/" + conf.epoch_fee_bps + "/" + conf.one_btc_fee_bps + "/" + conf.protocol_fee_bps + "/" + conf.buybacks_fee_bps + " bps)" : "NOT readable — check RPC_HTTP_URL"}`);
} catch (e) {
  console.log(`rpc check failed: ${(e as Error).message} — set RPC_HTTP_URL in .env`);
}

// 4. deposit
const d = depositInfo(primary.toBase58(), usdcMint, set.size);
console.log(`\n══════════════════════════════════════════════════════════════`);
console.log(`  DEPOSIT ADDRESS (the primary; the fleet funds itself from it)`);
console.log(`  ${d.address}`);
console.log(`  minimum first deposit: ${d.minUsdc} USDC + ${d.minSol} SOL   (more USDC = more rounds funded; the bot converts ~15% of volume into vault shares)`);
console.log(`══════════════════════════════════════════════════════════════`);
console.log(`\nUSDC — scan with a phone wallet (Solana Pay):\n${await qrAscii(d.usdcUri)}\n${d.usdcUri}`);
console.log(`\nSOL — fees and rent:\n${await qrAscii(d.solUri)}\n${d.solUri}`);
console.log(`\nmode: ${cfg.EXECUTION_MODE}${cfg.EXECUTION_MODE === "mainnet" ? " (MAINNET_CONFIRM set — the bot WILL send)" : " (dry — nothing is sent; re-run with --mainnet to arm)"}`);
console.log(`start: pnpm dev   ·   watch: /fleet /deposit in Telegram, or the dashboard`);

// 5. wait for funds
if (wait) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(usdcMint), primary);
  console.log(`\nwaiting for the deposit (polling every 10 s; Ctrl-C to stop)…`);
  for (;;) {
    const [sol, usdc] = await Promise.all([
      connection.getBalance(primary).then((l) => l / 1e9).catch(() => 0),
      connection.getTokenAccountBalance(ata).then((b) => Number(b.value.uiAmount ?? 0)).catch(() => 0),
    ]);
    process.stdout.write(`\r  primary: ${usdc.toFixed(2)} USDC · ${sol.toFixed(3)} SOL   `);
    if (usdc >= d.minUsdc && sol >= d.minSol) { console.log(`\n  funded. run: pnpm dev`); break; }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
