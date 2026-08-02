/**
 * Exec-path acceptance demo: full pre-sign → fire-at-slot → race-send →
 * confirm pipeline with a self-transfer stand-in transaction from a
 * throwaway keypair (devnet SOL only — no program interaction, no USDC).
 *
 *   EXECUTION_MODE=devnet pnpm exec tsx scripts/demo-exec.ts
 *
 * In dry mode everything runs but the sender logs the would-be send and
 * returns a synthetic confirmation.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { FeeEstimator } from "../src/exec/fees.js";
import { RaceSender } from "../src/exec/sender.js";
import { assembleTx } from "../src/exec/tx.js";

const cfg = loadConfig();
if (cfg.EXECUTION_MODE === "mainnet") {
  throw new Error("demo is devnet/dry only");
}
const mode = cfg.EXECUTION_MODE;
const connection = new Connection(cfg.RPC_HTTP_URL, "processed");
const connections = [
  connection,
  ...cfg.SECONDARY_RPC_URLS.map((url) => new Connection(url, "processed")),
];

// Throwaway keypair, persisted to the gitignored keypairs/ dir so it can be
// funded externally when the faucet is dry. Secret never logged.
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
const { dirname } = await import("node:path");
const keypairPath = cfg.KEYPAIR_PATH;
let payer: Keypair;
if (existsSync(keypairPath)) {
  payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]),
  );
  logger.info({ pubkey: payer.publicKey.toBase58(), keypairPath, mode }, "keypair loaded");
} else {
  payer = Keypair.generate();
  mkdirSync(dirname(keypairPath), { recursive: true });
  writeFileSync(keypairPath, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
  logger.info(
    { pubkey: payer.publicKey.toBase58(), keypairPath, mode },
    "throwaway keypair generated and saved",
  );
}

// ── fund (devnet mode only) ──────────────────────────────────────────────────
if (mode === "devnet") {
  let funded = (await connection.getBalance(payer.publicKey, "confirmed")) > 10_000;
  for (const sol of funded ? [] : [0.05, 0.02, 0.01]) {
    try {
      const sig = await connection.requestAirdrop(
        payer.publicKey,
        Math.round(sol * LAMPORTS_PER_SOL),
      );
      logger.info({ sol, sig: sig.slice(0, 20) }, "airdrop requested");
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 700));
        if ((await connection.getBalance(payer.publicKey, "confirmed")) > 0) {
          funded = true;
          break;
        }
      }
      if (funded) break;
    } catch (err) {
      logger.warn({ sol, err: String(err) }, "airdrop attempt failed");
    }
  }
  if (!funded) {
    logger.error(
      { fundMe: payer.publicKey.toBase58() },
      "devnet faucet refused all airdrops — send ~0.01 devnet SOL to this address and rerun",
    );
    process.exit(2);
  }
  logger.info(
    { lamports: await connection.getBalance(payer.publicKey, "confirmed") },
    "funded",
  );
}

// ── fee estimate ─────────────────────────────────────────────────────────────
const fees = new FeeEstimator({
  minMicroLamports: cfg.PRIORITY_FEE_MIN_MICROLAMPORTS,
  maxMicroLamports: cfg.PRIORITY_FEE_MAX_MICROLAMPORTS,
});
await fees.refreshFromRpc(connection);
const feeMicroLamports = fees.currentMicroLamportsPerCu();

// ── pre-sign the candidate (stand-in: 1000-lamport self-transfer) ────────────
const tBuildStart = Date.now();
const slotAtBuild = await connection.getSlot("processed");
const { tx, lastValidBlockHeight, blockhash } = await assembleTx(connection, {
  payer,
  instructions: [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1000,
    }),
  ],
  computeUnitLimit: 20_000,
  priorityFeeMicroLamports: feeMicroLamports,
});
const candidate = {
  signature: bs58.encode(tx.signatures[0]!),
  serialized: Buffer.from(tx.serialize()),
  lastValidBlockHeight,
  meta: { kind: "self_transfer_standin", lamports: 1000, feeMicroLamports },
};
const buildMs = Date.now() - tBuildStart;
logger.info(
  { slotAtBuild, blockhash: blockhash.slice(0, 8), buildMs, sig: candidate.signature },
  "candidate pre-signed and hot",
);

// ── wait for the target slot (stand-in for FIRE_OFFSET_SLOTS timing) ─────────
const targetSlot = slotAtBuild + 25;
const fireAtSlot = targetSlot - cfg.FIRE_OFFSET_SLOTS;
const cutoffSlot = targetSlot + 20;
let lastSlot = slotAtBuild;
logger.info({ targetSlot, fireAtSlot, cutoffSlot }, "waiting for fire slot…");
while (mode === "devnet" && lastSlot < fireAtSlot) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    lastSlot = await connection.getSlot("processed");
  } catch {
    /* transient — keep polling */
  }
}
const slotAtFire = lastSlot;

// ── fire: race-send the pre-signed bytes ─────────────────────────────────────
const sender = new RaceSender({
  mode,
  connections,
  jitoUrl: cfg.JITO_BLOCK_ENGINE_URL,
  logger,
});
const tFire = Date.now();
const result = await sender.fire(candidate, {
  isPastCutoff: () => lastSlot > cutoffSlot,
});
// keep the slot fresh for the timing report
try {
  lastSlot = await connection.getSlot("processed");
} catch {
  /* report uses last known */
}

// ── timing report ────────────────────────────────────────────────────────────
const lines = [
  "",
  "══════════ EXEC PATH TIMING REPORT ══════════",
  ` mode                ${mode}`,
  ` endpoints raced     ${connections.length}${cfg.JITO_BLOCK_ENGINE_URL ? " + jito" : ""}`,
  ` fee (µLam/CU)       ${feeMicroLamports}`,
  ` signature           ${candidate.signature}`,
  "──────────────────────────────────────────────",
  ` build   slot ${slotAtBuild}   (${buildMs} ms to pre-sign)`,
  ` fire    slot ${slotAtFire}   (+${slotAtFire - slotAtBuild} slots after build, target ${targetSlot})`,
  result.outcome === "landed"
    ? ` landed  slot ${result.landedSlot}   (+${(result.landedSlot ?? 0) - slotAtFire} slots after fire)`
    : ` outcome ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`,
  ` fire→resolve        ${result.timing.resolvedAtMs - result.timing.firedAtMs} ms`,
  ` send attempts       ${result.timing.sendAttempts} (${result.timing.perEndpointSends} endpoint sends)`,
  "══════════════════════════════════════════════",
].join("\n");
console.log(lines);
process.exit(result.outcome === "landed" || result.outcome === "dry" ? 0 : 1);
