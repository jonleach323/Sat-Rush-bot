/**
 * Read-only recon of the hashrate vaults on the configured cluster. Validates
 * the PDAs + decoders against live chain data and dumps current state (no
 * keypair, no sends). Run: source an env, then `pnpm exec tsx <this>`.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../../src/config.js";
import {
  decodeAccount,
  type EpochVault,
  type EpochVaultIteration,
  type OneBtcVault,
  type OneBtcVaultIteration,
} from "../../src/adapter/idl.js";
import {
  epochVaultIterationPda,
  epochVaultPda,
  minerPda,
  oneBtcVaultIterationPda,
  oneBtcVaultPda,
} from "../../src/adapter/pdas.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const programId = new PublicKey(cfg.PROGRAM_ID);
console.log(`cluster RPC host: ${new URL(cfg.RPC_HTTP_URL).host}`);
console.log(`program: ${programId.toBase58()}\n`);

async function read(name: string, pk: PublicKey): Promise<Buffer | null> {
  const info = await conn.getAccountInfo(pk, "confirmed");
  if (!info) {
    console.log(`✗ ${name}: NOT FOUND (${pk.toBase58()})`);
    return null;
  }
  console.log(`✓ ${name}: ${info.data.length} bytes (${pk.toBase58()})`);
  return info.data as Buffer;
}

// ── 1-BTC vault ──────────────────────────────────────────────────────────────
const obvData = await read("OneBtcVault", oneBtcVaultPda(programId));
if (obvData) {
  const v = decodeAccount<OneBtcVault>("OneBtcVault", obvData);
  console.log(
    `   iteration_id=${v.iteration_id} btc_amount=${v.btc_amount.toString()} ` +
      `reserved_btc=${v.reserved_btc_amount.toString()} pending_usd=${v.pending_usd_amount.toString()}`,
  );
  const itData = await read(
    "OneBtcVaultIteration",
    oneBtcVaultIterationPda(v.iteration_id, programId),
  );
  if (itData) {
    const it = decodeAccount<OneBtcVaultIteration>("OneBtcVaultIteration", itData);
    console.log(
      `   state=${Object.keys(it.state)[0]} total_tickets=${it.total_tickets.toString()} ` +
        `prize_btc=${it.prize_btc.toString()} winning_ticket=${it.winning_ticket.toString()}`,
    );
  }
}
console.log();

// ── epoch vault ──────────────────────────────────────────────────────────────
const evData = await read("EpochVault", epochVaultPda(programId));
if (evData) {
  const v = decodeAccount<EpochVault>("EpochVault", evData);
  console.log(
    `   iteration_id=${v.iteration_id} pool_usd=${v.pool_usd_amount.toString()} ` +
      `pool_btc=${v.pool_btc_amount.toString()} pending_usd=${v.pending_usd_amount.toString()}`,
  );
  const itData = await read(
    "EpochVaultIteration",
    epochVaultIterationPda(v.iteration_id, programId),
  );
  if (itData) {
    const it = decodeAccount<EpochVaultIteration>("EpochVaultIteration", itData);
    console.log(
      `   state=${Object.keys(it.state)[0]} total_tickets=${it.total_tickets.toString()} ` +
        `participants=${it.participants_count} pages=${it.page_count} ` +
        `winners_selected=${it.winners_selected}`,
    );
  }
}
console.log();

// ── our miner (hashrate available to buy tickets) ────────────────────────────
if (cfg.KEYPAIR_PATH) {
  try {
    const { loadKeypair } = await import("../../src/exec/tx.js");
    const kp = loadKeypair(cfg.KEYPAIR_PATH);
    console.log(`our wallet: ${kp.publicKey.toBase58()}`);
    const minerData = await read("Miner", minerPda(kp.publicKey, programId));
    if (minerData) {
      const { decodeAccount: dec } = await import("../../src/adapter/idl.js");
      const m = dec<{ hashrate_amount: { toString(): string }; unclaimed_hashrate: { toString(): string } }>(
        "Miner",
        minerData,
      );
      console.log(
        `   hashrate_amount=${m.hashrate_amount.toString()} unclaimed_hashrate=${m.unclaimed_hashrate.toString()}`,
      );
    }
  } catch (e) {
    console.log(`   (miner read skipped: ${String(e).slice(0, 80)})`);
  }
}
