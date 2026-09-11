/**
 * Boot preflight gates. In mainnet mode the orchestrator REFUSES to start
 * unless every fatal gate passes; `pnpm preflight` runs the same checks
 * standalone. Economics are compared against the devnet-measured baseline
 * (FINDINGS.md E6) — if the fee structure changed, the EV model is stale
 * and launching would be trading on wrong numbers.
 */
import { existsSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { SatrushConfig } from "../adapter/idl.js";
import { TokenFeed } from "../ingest/token-feed.js";
import { decodeAccount, PROGRAM_ADDRESS } from "../adapter/idl.js";
import { satrushConfigPda } from "../adapter/pdas.js";
import type { Config } from "../config.js";
import { loadKeypair } from "../exec/tx.js";
import { YellowstoneIngest } from "../ingest/grpc.js";
import { WsRpcIngest } from "../ingest/wsrpc.js";
import { StateDb } from "../state/db.js";
import { usdToBase } from "../units.js";

export interface GateResult {
  gate: string;
  ok: boolean;
  fatal: boolean;
  detail: string;
}

export interface PreflightReport {
  mode: string;
  effectiveMode: string;
  passed: boolean;
  gates: GateResult[];
}

/**
 * Mainnet V2 economics baseline, read from the live SatrushConfig and verified
 * against settled rounds to the cent (FINDINGS.md E-v2-live, 2026-09-11).
 * `sats_vault_round_fee_bps` is still 1200 on chain although the V2 swap
 * budget is 5% of gross — the model reads the swap leg from measurement, not
 * from this field; the gate only detects the owner changing the config.
 */
export const MEASURED_ECONOMICS = {
  strike_fee_bps: 208,
  epoch_fee_bps: 194,
  one_btc_fee_bps: 48,
  sats_vault_round_fee_bps: 1200,
  vault_exit_fee_bps: 1000,
  protocol_fee_bps: 100,
  unclaimed_hashrate_bps: 3500,
} as const;

/** Relative tolerance before the economics gate trips (25%). */
export const ECONOMICS_TOLERANCE = 0.25;

export function compareEconomics(
  config: Pick<SatrushConfig, keyof typeof MEASURED_ECONOMICS>,
  tolerance = ECONOMICS_TOLERANCE,
): { ok: boolean; deviations: string[] } {
  const deviations: string[] = [];
  for (const [field, baseline] of Object.entries(MEASURED_ECONOMICS)) {
    const actual = config[field as keyof typeof MEASURED_ECONOMICS];
    const drift = Math.abs(actual - baseline) / baseline; // baselines are nonzero constants
    if (drift > tolerance) {
      deviations.push(`${field}: measured ${baseline} → on-chain ${actual} (${(drift * 100).toFixed(0)}% drift)`);
    }
  }
  return { ok: deviations.length === 0, deviations };
}

export interface PreflightOptions {
  cfg: Config;
  /** Evaluate gates at this mode's severity (drill: pretend mainnet). */
  assumeMode?: "dry" | "devnet" | "mainnet" | undefined;
  /** Seconds to wait for a live ingest slot (default 8). */
  ingestWaitS?: number | undefined;
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightReport> {
  const { cfg } = opts;
  const mode = opts.assumeMode ?? cfg.EXECUTION_MODE;
  const strict = mode === "mainnet";
  const gates: GateResult[] = [];
  const gate = (name: string, ok: boolean, detail: string, fatalWhenStrict = true) =>
    gates.push({ gate: name, ok, fatal: strict && fatalWhenStrict, detail });

  // 1. mode gate
  gate(
    "mode_gate",
    mode !== "mainnet" || cfg.MAINNET_CONFIRM === "yes",
    mode === "mainnet"
      ? `EXECUTION_MODE=mainnet, MAINNET_CONFIRM=${cfg.MAINNET_CONFIRM ?? "<unset>"}`
      : `mode ${mode} (mainnet gate evaluated as: MAINNET_CONFIRM=${cfg.MAINNET_CONFIRM ?? "<unset>"})`,
  );

  // 2. kill switch must be clear
  const killFilePresent = cfg.KILL_SWITCH_FILE !== "" && existsSync(cfg.KILL_SWITCH_FILE);
  gate(
    "kill_switch_clear",
    !killFilePresent,
    killFilePresent
      ? `kill file present at ${cfg.KILL_SWITCH_FILE} — refusing to launch`
      : `no kill file at ${cfg.KILL_SWITCH_FILE}`,
  );

  // 3. program id matches the IDL
  const programMatches = cfg.PROGRAM_ID === PROGRAM_ADDRESS;
  gate(
    "program_id_matches_idl",
    programMatches,
    programMatches
      ? `PROGRAM_ID == IDL address (${PROGRAM_ADDRESS.slice(0, 12)}…)`
      : `PROGRAM_ID ${cfg.PROGRAM_ID} != IDL ${PROGRAM_ADDRESS} — obtain the matching IDL from the owner before launch`,
  );

  const connection = new Connection(cfg.RPC_HTTP_URL, "confirmed");
  const programId = new PublicKey(cfg.PROGRAM_ID);

  // 4. program deployed + executable
  let satrushConfig: SatrushConfig | null = null;
  try {
    const programInfo = await connection.getAccountInfo(programId);
    gate(
      "program_deployed",
      programInfo?.executable === true,
      programInfo
        ? `program account present, executable=${programInfo.executable}`
        : "program account NOT FOUND on this RPC",
    );
    const configInfo = await connection.getAccountInfo(satrushConfigPda(programId));
    if (configInfo) satrushConfig = decodeAccount<SatrushConfig>("SatrushConfig", configInfo.data);
    gate(
      "satrush_config_decodes",
      satrushConfig !== null,
      satrushConfig
        ? `SatrushConfig decoded (usd_mint ${satrushConfig.usd_mint.toBase58().slice(0, 8)}…, btc_mint ${satrushConfig.btc_mint.toBase58().slice(0, 8)}…)`
        : "SatrushConfig missing or layout mismatch — HALT: request updated IDL (see RUNBOOK)",
    );
  } catch (err) {
    gate("program_deployed", false, `RPC failure: ${String(err)}`);
  }

  // 5. economics within tolerance of the measured baseline
  if (satrushConfig) {
    const econ = compareEconomics(satrushConfig);
    gate(
      "economics_within_tolerance",
      econ.ok,
      econ.ok
        ? `all fee bps within ${ECONOMICS_TOLERANCE * 100}% of the mainnet V2 baseline`
        : `ECONOMICS CHANGED — EV model is stale: ${econ.deviations.join("; ")}`,
    );
    // 5b. the model version must match the program on chain. A V2 config
    // carries a real token_mint; V1's layout decodes that slot as zeros.
    const chainIsV2 = !satrushConfig.token_mint.equals(PublicKey.default);
    gate(
      "game_version_matches_chain",
      (cfg.GAME_VERSION === "v2") === chainIsV2,
      `GAME_VERSION=${cfg.GAME_VERSION}, on-chain config is ${chainIsV2 ? "V2 (token_mint set)" : "V1 (no token_mint)"}`,
    );
    // 5c. the RUSH leg is priced from the public API; without it the token
    // yield is the configured fallback (default 0 — conservative, so not fatal).
    if (cfg.GAME_VERSION === "v2") {
      const feed = new TokenFeed({
        apiUrl: cfg.SATRUSH_API_URL,
        fallback: { tokenUsd: cfg.RUSH_USD_ESTIMATE, mintRushPerUsd: cfg.RUSH_MINT_PER_USD_ESTIMATE },
        pollMs: 0,
      });
      await feed.refresh();
      const st = feed.status();
      gate(
        "token_feed_live",
        st.live,
        st.live
          ? `RUSH $${st.tokenUsd.toFixed(2)} × ${(st.mintRushPerUsd * 1000).toFixed(3)} RUSH/$1k over ${st.mintSampleRounds} rounds → yield ${(st.yieldPerVolume * 100).toFixed(2)}% of volume`
          : `API ${cfg.SATRUSH_API_URL} not answering — token leg priced at the fallback (${(st.yieldPerVolume * 100).toFixed(2)}%)`,
        false,
      );
    }
    const minDeploy = BigInt(satrushConfig.min_deploy_usd_amount.toString());
    gate(
      "min_deploy_vs_caps",
      minDeploy <= usdToBase(cfg.MAX_PER_ROUND_USD),
      `on-chain min deploy ${minDeploy} vs MAX_PER_ROUND ${usdToBase(cfg.MAX_PER_ROUND_USD)}`,
    );
  }

  // 6. caps sanity (config cross-checks re-asserted at the gate)
  const ladder = cfg.STAKE_LADDER_USD.map(usdToBase);
  const capsOk =
    cfg.MAX_PER_ROUND_USD > 0 &&
    cfg.MAX_PER_ROUND_USD <= cfg.DAILY_LOSS_CAP_USD &&
    ladder.every((l) => l <= usdToBase(cfg.MAX_PER_ROUND_USD));
  gate(
    "caps_set",
    capsOk,
    `MAX_PER_ROUND $${cfg.MAX_PER_ROUND_USD}, DAILY_LOSS_CAP $${cfg.DAILY_LOSS_CAP_USD}, ladder [${cfg.STAKE_LADDER_USD.join(",")}]`,
  );

  // 7. wallet: keypair loads, SOL above floor, USDC ATA funded
  try {
    const payer = loadKeypair(cfg.KEYPAIR_PATH);
    const sol = await connection.getBalance(payer.publicKey, "confirmed");
    gate(
      "wallet_sol_floor",
      sol >= cfg.SOL_FLOOR_SOL * 1e9,
      `${(sol / 1e9).toFixed(4)} SOL (floor ${cfg.SOL_FLOOR_SOL})`,
    );
    if (satrushConfig) {
      const ata = getAssociatedTokenAddressSync(satrushConfig.usd_mint, payer.publicKey);
      try {
        const balance = await connection.getTokenAccountBalance(ata, "confirmed");
        const usd = BigInt(balance.value.amount);
        const needed = usdToBase(cfg.MAX_PER_ROUND_USD);
        const tenRounds = needed * 10n;
        gates.push({
          gate: "usdc_ata_funded",
          ok: usd >= needed,
          fatal: strict && usd < needed,
          detail: `${balance.value.uiAmountString} USDC${usd < tenRounds ? " (warn: < 10 rounds of budget)" : ""}`,
        });
      } catch {
        gate("usdc_ata_funded", false, "USDC ATA missing — fund the wallet first");
      }
    }
  } catch (err) {
    gate("wallet_sol_floor", false, `keypair load failed: ${String(err)}`);
  }

  // 8. Telegram reachable
  if (cfg.TELEGRAM_TOKEN && cfg.TELEGRAM_CHAT_ID) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(
        `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/getMe`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
      gate(
        "telegram_reachable",
        body.ok === true,
        body.ok ? `getMe ok (@${body.result?.username})` : `getMe failed: HTTP ${res.status}`,
        false, // non-fatal: Telegram is an alert/ops channel, not money-path.
        // It is intermittently reachable from some hosts; an outage must not
        // block trading. On-chain reconcile tripwires + the KILL file remain
        // the load-bearing safety net regardless of Telegram.
      );
    } catch (err) {
      gate("telegram_reachable", false, `unreachable: ${String(err).slice(0, 80)}`, false);
    }
  } else {
    gate("telegram_reachable", false, "TELEGRAM_TOKEN/CHAT_ID unset — no ops channel", false);
  }

  // 9. ingest freshness (gRPC when configured; ws-rpc fallback noted)
  {
    const waitMs = (opts.ingestWaitS ?? 8) * 1_000;
    const source = cfg.GRPC_URL
      ? new YellowstoneIngest({
          endpoint: cfg.GRPC_URL,
          xToken: cfg.GRPC_TOKEN,
          programId,
          watchAccounts: [],
          stalenessMs: cfg.STALENESS_MS,
        })
      : new WsRpcIngest({
          httpUrl: cfg.RPC_HTTP_URL,
          programId,
          watchAccounts: [],
          stalenessMs: cfg.STALENESS_MS,
        });
    const sourceName = cfg.GRPC_URL ? "yellowstone-grpc" : "ws-rpc fallback";
    let firstSlot: number | null = null;
    const gotSlot = new Promise<void>((resolve) => {
      source.on("slot", (u) => {
        if (firstSlot === null) {
          firstSlot = u.slot;
          resolve();
        }
      });
    });
    await source.start();
    await Promise.race([gotSlot, new Promise((r) => setTimeout(r, waitMs))]);
    await source.stop().catch(() => undefined);
    gate(
      "ingest_fresh",
      firstSlot !== null,
      firstSlot !== null
        ? `${sourceName} delivered slot ${firstSlot} within ${opts.ingestWaitS ?? 8}s`
        : `${sourceName}: NO slot update within ${opts.ingestWaitS ?? 8}s`,
    );
    if (!cfg.GRPC_URL) {
      gates.push({
        gate: "grpc_configured",
        ok: false,
        fatal: false, // warn — the fallback works, but mainnet wants gRPC
        detail: "GRPC_URL unset — running on the ws-rpc fallback (higher latency, weaker delivery)",
      });
    }
  }

  // 10. DB writable
  try {
    const db = new StateDb(cfg.DB_PATH);
    const journal = db.queryOne<{ journal_mode: string }>("PRAGMA journal_mode");
    db.close();
    gate("db_writable", journal?.journal_mode === "wal", `${cfg.DB_PATH} (WAL)`);
  } catch (err) {
    gate("db_writable", false, `DB open failed: ${String(err)}`);
  }

  const passed = !gates.some((g) => !g.ok && g.fatal);
  return { mode: cfg.EXECUTION_MODE, effectiveMode: mode, passed, gates };
}

export function formatPreflight(report: PreflightReport): string {
  const lines = [
    `══════════ PREFLIGHT (${report.effectiveMode}${report.effectiveMode !== report.mode ? `, actual mode ${report.mode}` : ""}) ══════════`,
  ];
  for (const g of report.gates) {
    const mark = g.ok ? "✅" : g.fatal ? "❌ FATAL" : "⚠️  warn";
    lines.push(` ${mark}  ${g.gate.padEnd(28)} ${g.detail}`);
  }
  lines.push(
    report.passed
      ? "══════════ PREFLIGHT PASSED ══════════"
      : "══════════ PREFLIGHT FAILED — NOT LAUNCHING ══════════",
  );
  return lines.join("\n");
}
