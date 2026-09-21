/**
 * Read the live SatrushConfig off mainnet for research scripts. The public
 * API's /config omits `strike_trigger_modulus` and `buybacks_fee_bps`, and
 * both have been changed by the owner since launch (modulus 1440 → 1097,
 * buybacks 50 → 108 bps), so scripts must not carry them as literals.
 * Public RPC by default; falls back to null so a script can degrade to the
 * API + facts with a printed warning rather than a wrong number.
 */
import { Connection } from "@solana/web3.js";
import { decodeAccount } from "../../src/adapter/idl.js";
import { satrushConfigPda } from "../../src/adapter/pdas.js";
import type { SatrushConfig } from "../../src/adapter/generated-types.js";

export async function readSatrushConfig(rpcUrl = process.env["RPC_URL"] ?? process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com"): Promise<SatrushConfig | null> {
  try {
    const c = new Connection(rpcUrl, "confirmed");
    const info = await c.getAccountInfo(satrushConfigPda());
    if (!info) return null;
    return decodeAccount<SatrushConfig>("SatrushConfig", info.data);
  } catch {
    return null;
  }
}

/** Live 1-BTC vault fill and the open iteration's ticket count (the API list omits both). */
export async function readOneBtcState(rpcUrl = process.env["RPC_URL"] ?? process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com"): Promise<{ iterationId: number; btcAmount: number; totalTickets: number } | null> {
  try {
    const { oneBtcVaultPda, oneBtcVaultIterationPda } = await import("../../src/adapter/pdas.js");
    const c = new Connection(rpcUrl, "confirmed");
    const vaultInfo = await c.getAccountInfo(oneBtcVaultPda());
    if (!vaultInfo) return null;
    const vault = decodeAccount<{ iteration_id: number; btc_amount: { toString(): string } }>("OneBtcVault", vaultInfo.data);
    const iterInfo = await c.getAccountInfo(oneBtcVaultIterationPda(vault.iteration_id));
    if (!iterInfo) return null;
    const iter = decodeAccount<{ total_tickets: { toString(): string } }>("OneBtcVaultIteration", iterInfo.data);
    return { iterationId: vault.iteration_id, btcAmount: Number(vault.btc_amount.toString()) / 1e8, totalTickets: Number(iter.total_tickets.toString()) };
  } catch {
    return null;
  }
}
