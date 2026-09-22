import { describe, expect, it } from "vitest";
import { loadConfig, summarizeConfig } from "../src/config.js";

describe("config defaults", () => {
  it("loads from an empty env with safe defaults", () => {
    const cfg = loadConfig({});
    expect(cfg.EXECUTION_MODE).toBe("dry");
    expect(cfg.FIRE_OFFSET_SLOTS).toBe(4);
    expect(cfg.K_EMPTIEST).toBe(3);
    expect(cfg.DB_PATH).toBe("./data/satrush.db");
    expect(cfg.SECONDARY_RPC_URLS).toEqual([]);
    expect(cfg.STAKE_LADDER_USD.length).toBeGreaterThan(0);
    expect(cfg.MAX_PER_ROUND_USD).toBe(0); // auto: the fleet's deployable USDC
    expect(cfg.DAILY_LOSS_CAP_USD).toBe(0); // auto: AUTO_DAILY_LOSS_FRACTION of the day's opening USDC
    expect(cfg.FLEET_SIZE).toBe(21);
    // Vault strategy is ON by default — spends idle hashrate on +share raffles
    // (bounded, and EXECUTION_MODE-gated so dry mode still sends nothing).
    expect(cfg.VAULT_STRATEGY_ENABLED).toBe(true);
    expect(cfg.VAULT_HASHRATE_PER_TICKET).toBe(100); // measured on devnet
    expect(cfg.VAULT_MAX_TICKETS).toBeGreaterThan(0);
    expect(cfg.VAULT_HASHRATE_FRACTION).toBeGreaterThanOrEqual(0);
    expect(cfg.VAULT_HASHRATE_FRACTION).toBeLessThanOrEqual(1);
    expect(cfg.VAULT_EPOCH_LATE_SLOTS).toBeGreaterThan(0);
    expect(cfg.VAULT_ONE_BTC_MIN_FILL_BPS).toBeGreaterThan(0);
    expect(cfg.VAULT_SELF_CRANK).toBe(false);
    expect(cfg.ANTI_COLLISION_ENABLED).toBe(true);
    expect(cfg.COMPETITOR_LOOKBACK).toBeGreaterThan(0);
    // USDC compound loop on by default (fee-free); BTC-share sweep opt-in.
    expect(cfg.CLAIM_USD_ENABLED).toBe(true);
    expect(cfg.SWEEP_ENABLED).toBe(false);
    // Payout-dilution corrections are ON by default (they only make the bot
    // more selective): thin tiles converge toward the board mean, and a
    // minimum modeled edge is required to fire.
    expect(cfg.ENDGAME_CONVERGENCE).toBe(0); // V2: the board is final at the fire offset (pnpm v2-timing)
    expect(cfg.AUTO_RAMP).toBe(true);
    expect(cfg.RAMP_PRESENCE_TOLL_BPS).toBe(300);
    expect(cfg.ENDGAME_CONVERGENCE).toBeLessThanOrEqual(1);
    expect(cfg.MIN_EDGE_BPS).toBe(25); // margin over the model's own noise
    expect(cfg.EDGE_HURDLE_ENABLED).toBe(true);
    expect(cfg.OPPORTUNITY_YIELD_DAILY).toBeGreaterThan(0);
    // Full Kelly by default (growth-maximizing); clamped at 1.0.
    expect(cfg.KELLY_FRACTION).toBe(0); // EV-max: Kelly (log-growth) would size below the argmax
    expect(cfg.AUTO_DAILY_LOSS_FRACTION).toBe(1);
    expect(cfg.VAULT_MAX_SHARE).toBe(1);
    expect(cfg.STREAK_OPTION_DISCOUNT).toBe(1);
    expect(cfg.RAMP_ALERT_MIN_BPS).toBe(5);
    // Strike jackpot expectation is folded into EV by default.
    expect(cfg.STRIKE_EV_ENABLED).toBe(true);
    // Adaptive fire timing on by default, within sane bounds.
    expect(cfg.ADAPTIVE_FIRE_OFFSET).toBe(true);
    expect(cfg.FIRE_OFFSET_FLOOR).toBeLessThanOrEqual(cfg.FIRE_OFFSET_CEILING);
    expect(cfg.FIRE_OFFSET_TARGET_LAND_PROB).toBeGreaterThan(0);
    expect(cfg.FIRE_OFFSET_TARGET_LAND_PROB).toBeLessThanOrEqual(1);
  });

  it("treats empty strings as unset", () => {
    const cfg = loadConfig({ GRPC_URL: "", EXECUTION_MODE: "" });
    expect(cfg.GRPC_URL).toBeUndefined();
    expect(cfg.EXECUTION_MODE).toBe("dry");
  });

  it("parses comma lists", () => {
    const cfg = loadConfig({
      SECONDARY_RPC_URLS: "https://a.example.com, https://b.example.com",
      STAKE_LADDER_USD: "0.5,1",
      MAX_PER_ROUND_USD: "1",
    });
    expect(cfg.SECONDARY_RPC_URLS).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(cfg.STAKE_LADDER_USD).toEqual([0.5, 1]);
  });
});

describe("gates and cross-checks", () => {
  it("loads mainnet without MAINNET_CONFIRM (read-only tooling must work pre-arm)", () => {
    // Enforcement moved to the send/boot layer: RaceSender refuses to
    // construct and preflight mode_gate is fatal without the confirm.
    const cfg = loadConfig({ EXECUTION_MODE: "mainnet" });
    expect(cfg.EXECUTION_MODE).toBe("mainnet");
    expect(cfg.MAINNET_CONFIRM).toBeUndefined();
  });

  it("accepts mainnet with MAINNET_CONFIRM=yes", () => {
    const cfg = loadConfig({ EXECUTION_MODE: "mainnet", MAINNET_CONFIRM: "yes" });
    expect(cfg.EXECUTION_MODE).toBe("mainnet");
  });

  it("rejects unknown execution modes", () => {
    expect(() => loadConfig({ EXECUTION_MODE: "prod" })).toThrow();
  });

  it("rejects a stake ladder that exceeds MAX_PER_ROUND_USD", () => {
    expect(() =>
      loadConfig({ STAKE_LADDER_USD: "5", MAX_PER_ROUND_USD: "2" }),
    ).toThrow(/exceeds MAX_PER_ROUND_USD/);
  });

  it("rejects MAX_PER_ROUND_USD above DAILY_LOSS_CAP_USD", () => {
    expect(() =>
      loadConfig({ MAX_PER_ROUND_USD: "10", DAILY_LOSS_CAP_USD: "5", STAKE_LADDER_USD: "1" }),
    ).toThrow(/DAILY_LOSS_CAP_USD/);
  });

  it("rejects a fire-offset ceiling below the floor", () => {
    expect(() =>
      loadConfig({ FIRE_OFFSET_FLOOR: "5", FIRE_OFFSET_CEILING: "3" }),
    ).toThrow(/FIRE_OFFSET_CEILING/);
  });

  it("rejects a jito tip max below the base", () => {
    expect(() =>
      loadConfig({ JITO_TIP_LAMPORTS: "50000", JITO_TIP_MAX_LAMPORTS: "10000" }),
    ).toThrow(/JITO_TIP_MAX_LAMPORTS/);
  });

  it("rejects invalid pubkeys", () => {
    expect(() => loadConfig({ PROGRAM_ID: "not-a-pubkey" })).toThrow();
    expect(() => loadConfig({ USD_MINT: "zzz" })).toThrow();
  });
});

describe("redacted summary", () => {
  it("never contains tokens or URL paths/keys", () => {
    const cfg = loadConfig({
      RPC_HTTP_URL: "https://rpc.example.com/v2/SECRET-API-KEY",
      GRPC_TOKEN: "grpc-secret-token",
      TELEGRAM_TOKEN: "tg-secret-token",
    });
    const text = JSON.stringify(summarizeConfig(cfg));
    expect(text).not.toContain("SECRET-API-KEY");
    expect(text).not.toContain("grpc-secret-token");
    expect(text).not.toContain("tg-secret-token");
    expect(text).toContain("https://rpc.example.com");
  });
});

describe("V2 game version + token feed knobs", () => {
  it("defaults to the live V2 economics with an unpriced token leg", () => {
    const cfg = loadConfig({});
    expect(cfg.GAME_VERSION).toBe("v2");
    expect(cfg.SATRUSH_API_URL).toBe("https://api.satrush.io/api/v1");
    expect(cfg.RUSH_USD_ESTIMATE).toBe(0);
    expect(cfg.RUSH_MINT_PER_USD_ESTIMATE).toBe(0);
    expect(cfg.TOKEN_FEED_MAX_AGE_MS).toBeGreaterThan(cfg.TOKEN_FEED_POLL_MS);
    expect(cfg.VAULT_CARRY_HORIZON_DAYS).toBe(30); // holding is the stated intent (2026-09-22); /pnl re-checks hold vs claim and alerts on a flip
    expect(cfg.VAULT_CARRY_APR_CAP).toBeCloseTo(1.2, 6);
    expect(loadConfig({ VAULT_CARRY_HORIZON_DAYS: "90" }).VAULT_CARRY_HORIZON_DAYS).toBe(90);
    expect(() => loadConfig({ VAULT_CARRY_HORIZON_DAYS: "400" })).toThrow();
  });

  it("accepts v1 for replay and rejects anything else", () => {
    expect(loadConfig({ GAME_VERSION: "v1" }).GAME_VERSION).toBe("v1");
    expect(() => loadConfig({ GAME_VERSION: "v3" })).toThrow();
    expect(() => loadConfig({ RUSH_MINT_PER_USD_ESTIMATE: "2" })).toThrow();
  });
});
