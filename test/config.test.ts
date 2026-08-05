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
    expect(cfg.MAX_PER_ROUND_USD).toBeLessThanOrEqual(cfg.DAILY_LOSS_CAP_USD);
    // Vault strategy is OFF by default — never buys tickets unless opted in.
    expect(cfg.VAULT_STRATEGY_ENABLED).toBe(false);
    expect(cfg.VAULT_HASHRATE_PER_TICKET).toBe(100); // measured on devnet
    expect(cfg.VAULT_MAX_TICKETS).toBeGreaterThan(0);
    expect(cfg.VAULT_HASHRATE_FRACTION).toBeGreaterThanOrEqual(0);
    expect(cfg.VAULT_HASHRATE_FRACTION).toBeLessThanOrEqual(1);
    expect(cfg.VAULT_EPOCH_LATE_SLOTS).toBeGreaterThan(0);
    expect(cfg.VAULT_ONE_BTC_MIN_FILL_BPS).toBeGreaterThan(0);
    expect(cfg.VAULT_SELF_CRANK).toBe(false);
    expect(cfg.ANTI_COLLISION_ENABLED).toBe(false);
    expect(cfg.COMPETITOR_LOOKBACK).toBeGreaterThan(0);
    // Payout-dilution corrections are ON by default (they only make the bot
    // more selective): thin tiles converge toward the board mean, and a
    // minimum modeled edge is required to fire.
    expect(cfg.ENDGAME_CONVERGENCE).toBeGreaterThan(0);
    expect(cfg.ENDGAME_CONVERGENCE).toBeLessThanOrEqual(1);
    expect(cfg.MIN_EDGE_BPS).toBeGreaterThan(0);
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
