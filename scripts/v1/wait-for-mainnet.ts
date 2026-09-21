/**
 * Launch watcher: polls the cluster in .env until the Sat Rush program is
 * deployed AND its config decodes with our IDL AND the economics match the
 * measured baseline — then prints GO and exits 0.
 *
 *   pnpm wait:launch            # poll every 15s until live
 *   pnpm wait:launch -- --once  # single check, exit 0/1
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type { SatrushConfig } from "../../src/adapter/idl.js";
import { decodeAccount } from "../../src/adapter/idl.js";
import { boardPda, satrushConfigPda } from "../../src/adapter/pdas.js";
import { loadConfig } from "../../src/config.js";
import { compareEconomics } from "../../src/ops/preflight.js";

const cfg = loadConfig();
const once = process.argv.includes("--once");
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const programId = new PublicKey(cfg.PROGRAM_ID);
const host = new URL(cfg.RPC_HTTP_URL).host;
const stamp = () => new Date().toISOString().slice(11, 19);

console.log(`watching ${host} for program ${cfg.PROGRAM_ID.slice(0, 16)}… (every 15s)`);

for (;;) {
  try {
    const program = await conn.getAccountInfo(programId);
    if (!program?.executable) {
      console.log(`[${stamp()}] not deployed yet`);
    } else {
      const [configInfo, boardInfo] = await conn.getMultipleAccountsInfo([
        satrushConfigPda(programId),
        boardPda(programId),
      ]);
      if (!configInfo) {
        console.log(`[${stamp()}] program deployed, satrush_config not initialized yet`);
      } else {
        let satrushConfig: SatrushConfig | null = null;
        try {
          satrushConfig = decodeAccount<SatrushConfig>("SatrushConfig", configInfo.data);
        } catch (err) {
          console.log(`[${stamp()}] ❌ config exists but DOES NOT DECODE with our IDL — request the mainnet IDL from the owner before doing anything (${String(err).slice(0, 80)})`);
          process.exit(2);
        }
        const econ = compareEconomics(satrushConfig);
        console.log(`\n[${stamp()}] ══════ PROGRAM LIVE ON ${host} ══════`);
        console.log(`  usd_mint  ${satrushConfig.usd_mint.toBase58()}`);
        console.log(`  btc_mint  ${satrushConfig.btc_mint.toBase58()}`);
        console.log(
          `  fees bps  strike ${satrushConfig.strike_fee_bps} epoch ${satrushConfig.epoch_fee_bps} 1btc ${satrushConfig.one_btc_fee_bps} svRound ${satrushConfig.sats_vault_round_fee_bps} svClaim ${satrushConfig.vault_exit_fee_bps} protocol ${satrushConfig.protocol_fee_bps}`,
        );
        console.log(`  min deploy $${Number(satrushConfig.min_deploy_usd_amount.toString()) / 1e6}`);
        console.log(`  board     ${boardInfo ? "initialized" : "NOT YET INITIALIZED"}`);
        console.log(
          econ.ok
            ? "  economics ✅ match the devnet-measured baseline"
            : `  economics ⚠️  CHANGED vs baseline:\n    ${econ.deviations.join("\n    ")}\n    → review the EV model before arming MAINNET_CONFIRM`,
        );
        console.log("\n  next: pnpm preflight → set MAINNET_CONFIRM=yes → pnpm preflight → start");
        process.exit(econ.ok && boardInfo ? 0 : 1);
      }
    }
  } catch (err) {
    console.log(`[${stamp()}] rpc error: ${String(err).slice(0, 80)}`);
  }
  if (once) process.exit(1);
  await new Promise((r) => setTimeout(r, 15_000));
}
