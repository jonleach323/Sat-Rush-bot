import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { lintConfig } from "../src/ops/config-lint.js";

const base = { KEYPAIR_PATH: "/tmp/nope.json", EXECUTION_MODE: "mainnet", MAINNET_CONFIRM: "yes", RPC_HTTP_URL: "https://x", RPC_WS_URL: "wss://x" };

describe("config lint — the 2026-09-21 env, one finding per lesson", () => {
  it("flags the deployed values and names the fix", () => {
    const cfg = loadConfig({ ...base, STALENESS_MS: "20000", PRICE_MAX_STALE_SLOTS: "150", MAX_PER_ROUND_USD: "21" } as NodeJS.ProcessEnv);
    const f = lintConfig(cfg, { fleetUsdcBase: 35_409_000_000n, killFilePresent: true, distStale: true });
    const byKey = Object.fromEntries(f.map((x) => [x.key, x]));
    expect(byKey["staleness_ms"]?.severity).toBe("warn");
    expect(byKey["price_stale_gate"]?.severity).toBe("warn");
    expect(byKey["hand_cap"]?.severity).toBe("warn"); // $21 against $35k
    expect(byKey["hand_cap"]?.message).toMatch(/canary/);
    expect(byKey["kill_file"]?.severity).toBe("warn");
    expect(byKey["stale_build"]?.severity).toBe("warn");
    expect(byKey["vault_carry_not_credited"]?.severity).toBe("info");
  });

  it("the intended env is clean apart from the stated-intent infos", () => {
    const cfg = loadConfig({ ...base } as NodeJS.ProcessEnv);
    const f = lintConfig(cfg, { fleetUsdcBase: 35_409_000_000n, killFilePresent: false, distStale: false });
    expect(f.filter((x) => x.severity === "warn")).toEqual([]);
    expect(f.map((x) => x.key)).toContain("vault_carry_not_credited");
  });
});
