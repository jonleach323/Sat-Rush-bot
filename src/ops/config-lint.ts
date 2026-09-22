/**
 * Operational config lint: the values that were each, on 2026-09-21, the
 * cause of an hour of wrong diagnosis — a V1-era STALENESS_MS that turned
 * the watchdog grace into 100 s, a price-stale gate tighter than the
 * oracle's heartbeat, a canary cap left in the env after the deposit, a
 * dist older than src. Pure: preflight reports the findings as non-fatal
 * gates, the orchestrator logs and alerts them at boot. Warn = fix it;
 * info = a deliberate choice worth restating.
 */
import type { Config } from "../config.js";

export interface ConfigFinding {
  key: string;
  severity: "warn" | "info";
  message: string;
}

export interface ConfigLintContext {
  killFilePresent?: boolean | undefined;
  /** Deployable USDC across the fleet (base units), when known. */
  fleetUsdcBase?: bigint | undefined;
  /** dist/index.js older than the newest source file (null when running from source). */
  distStale?: boolean | null | undefined;
}

export function lintConfig(cfg: Config, ctx: ConfigLintContext = {}): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  const warn = (key: string, message: string) => out.push({ key, severity: "warn", message });
  const info = (key: string, message: string) => out.push({ key, severity: "info", message });

  if (ctx.distStale) warn("stale_build", "dist/ is older than src/ — this process runs old code; run pnpm build (deploy/upgrade.sh does)");

  if (cfg.STALENESS_MS > 5_000) {
    warn("staleness_ms", `STALENESS_MS=${cfg.STALENESS_MS}: the fire gate and the stream watchdog grace (5× this, capped 30 s) are loosened; 1500 is the intended value`);
  }
  if (cfg.PRICE_MAX_STALE_SLOTS < 400) {
    warn("price_stale_gate", `PRICE_MAX_STALE_SLOTS=${cfg.PRICE_MAX_STALE_SLOTS}: the sponsored oracle feeds heartbeat every ~150 slots, so quotes are rejected at the heartbeat edge; 400 is the intended value`);
  }
  if (cfg.FIRE_OFFSET_CEILING < 10) {
    warn("fire_offset_ceiling", `FIRE_OFFSET_CEILING=${cfg.FIRE_OFFSET_CEILING}: at mainnet's ~267 ms slots the adaptive offset cannot open past ${(cfg.FIRE_OFFSET_CEILING * 0.267).toFixed(1)} s before cutoff; a 21-leg send needs room to widen after a miss — 12 is the intended value`);
  }
  if (cfg.MAX_PER_ROUND_USD > 0) {
    const usdc = ctx.fleetUsdcBase !== undefined ? Number(ctx.fleetUsdcBase) / 1e6 : null;
    const wide = usdc !== null && usdc > 10 * cfg.MAX_PER_ROUND_USD;
    (wide ? warn : info)(
      "hand_cap",
      `MAX_PER_ROUND_USD=${cfg.MAX_PER_ROUND_USD} is a hand cap${usdc !== null ? ` against $${usdc.toFixed(0)} of fleet USDC` : ""}: the model sizes to its EV optimum only up to it${wide ? " — a canary left in place after the deposit? comment it out for EV-max" : ""}`,
    );
  }
  if (cfg.DAILY_LOSS_CAP_USD > 0) info("hand_daily_cap", `DAILY_LOSS_CAP_USD=${cfg.DAILY_LOSS_CAP_USD} is a hand cap (0 derives it from the day's opening USDC)`);
  if (cfg.KELLY_FRACTION > 0) info("kelly_brake", `KELLY_FRACTION=${cfg.KELLY_FRACTION} sizes below the EV optimum (0 = EV-max)`);
  if (cfg.VAULT_MAX_SHARE < 1) info("vault_share_brake", `VAULT_MAX_SHARE=${cfg.VAULT_MAX_SHARE} caps hashrate by a hard share instead of the dilution curve`);
  if (cfg.STREAK_OPTION_DISCOUNT < 1) info("streak_option_discount", `STREAK_OPTION_DISCOUNT=${cfg.STREAK_OPTION_DISCOUNT} discounts the streak option`);
  if (cfg.VAULT_CARRY_HORIZON_DAYS === 0) {
    info("vault_carry_not_credited", "VAULT_CARRY_HORIZON_DAYS=0: the vault carry earned by holding shares is not credited; the operator's stated intent is to hold (default 30 d) — a 0 here is a deliberate override");
  }
  if (cfg.EXECUTION_MODE === "mainnet" && cfg.MIN_EDGE_BPS <= 0) warn("no_edge_floor", "MIN_EDGE_BPS=0 on mainnet: the selector fires on any positive EV, inside model noise; 25 is the intended floor");
  if (cfg.EXECUTION_MODE === "mainnet" && !cfg.EDGE_HURDLE_ENABLED) warn("no_edge_hurdle", "EDGE_HURDLE_ENABLED=false on mainnet: fees and the opportunity yield are not charged against a fire");
  if (cfg.FLEET_SIZE > 1 && cfg.WALLET_PATHS.length === 0 && !cfg.FLEET_TREASURY_ENABLED) warn("fleet_without_treasury", `FLEET_SIZE=${cfg.FLEET_SIZE} with FLEET_TREASURY_ENABLED=false: sub-wallets are never funded or swept`);
  if (cfg.EXECUTION_MODE === "mainnet" && !cfg.SELF_SETTLE) warn("self_settle_off", "SELF_SETTLE=false: the owner's settle crank has been offline for long stretches — deployment rent and winnings come back through self-settle");
  if (ctx.killFilePresent) warn("kill_file", `KILL file present at ${cfg.KILL_SWITCH_FILE}: trading, treasury and claims are all held (use Telegram /pause for a trading-only hold)`);
  return out;
}
