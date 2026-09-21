/**
 * pnpm env:migrate [path=.env] [--write]
 *
 * Upgrade a V1-era env file to the V2 fleet defaults WITHOUT losing anything
 * operator-specific. The bot now derives its sizing and risk limits from the
 * board and the bankroll; a hand-set value from the V1 days would silently
 * override that (a `MAX_PER_ROUND_USD=1` caps every round at $1). So: every
 * key on the DERIVED list that is set to something other than the new
 * default is commented out with a note; keys the schema no longer knows are
 * commented out as obsolete; RPC, keys, tokens, paths and anything else are
 * untouched. Prints the plan; `--write` applies it after saving a .bak copy.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_KEYS, loadConfig } from "../src/config.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const path = args.find((a) => !a.startsWith("--")) ?? ".env";
if (!existsSync(path)) throw new Error(`${path} not found`);

/** Keys the V2 bot derives; a V1 value here only ever caps extraction. */
const DERIVED: Record<string, string> = {
  MAX_PER_ROUND_USD: "0 = the fleet's deployable USDC",
  DAILY_LOSS_CAP_USD: "0 = the day's opening bankroll",
  AUTO_DAILY_LOSS_FRACTION: "1",
  KELLY_FRACTION: "0 (Kelly sizes below the EV argmax)",
  MIN_EDGE_BPS: "25 (model-noise margin) + the fee/opportunity hurdle",
  VAULT_MAX_SHARE: "1 (the dilution curve prices our share)",
  STREAK_OPTION_DISCOUNT: "1",
  STRIKE_BONUS_WINDOW_MINUTES: "the SDK's 240-round window is used instead",
  ENDGAME_CONVERGENCE: "0 (the board is final 40 s before cutoff)",
  RAMP_ALERT_MIN_BPS: "5 (the ramp's own payback)",
  HASHRATE_DEPLOY_CREDIT_ENABLED: "true",
  STREAK_OPTION_VALUE_ENABLED: "true",
  STRIKE_EV_ENABLED: "true",
  FLEET_WALLET_TARGET_USD: "derived from the observed peak leg (this is a floor)",
  FLEET_WALLET_LOW_USD: "derived (floor)",
  STRIKE_SIZE_BOOST: "1.0 (superseded by STRIKE_EV_ENABLED)",
};
/** Keys that must exist for V2 and their required values; anything else is left as is. */
const REQUIRED: Record<string, string> = { GAME_VERSION: "v2" };

const raw = readFileSync(path, "utf8");
const defaults = loadConfig({ KEYPAIR_PATH: "./keypairs/operator.json" }) as unknown as Record<string, unknown>;
const lines = raw.split("\n");
const out: string[] = [];
const report: string[] = [];
const seen = new Set<string>();
for (const line of lines) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m) { out.push(line); continue; }
  const [, key, value] = m as unknown as [string, string, string];
  seen.add(key);
  if (key in REQUIRED && value.trim() !== REQUIRED[key]) {
    report.push(`set      ${key}=${REQUIRED[key]}   (was ${value})`);
    out.push(`# migrated to V2: was ${key}=${value}`, `${key}=${REQUIRED[key]}`);
    continue;
  }
  if (key in DERIVED) {
    const def = defaults[key];
    const same = def !== undefined && String(def) === value.trim();
    if (!same && value.trim() !== "") {
      report.push(`derive   ${key}   (was ${value}; now ${DERIVED[key]})`);
      out.push(`# migrated (V2 derives this — ${DERIVED[key]}): ${key}=${value}`);
      continue;
    }
  }
  if (!CONFIG_KEYS.includes(key) && !["MAINNET_CONFIRM"].includes(key)) {
    report.push(`obsolete ${key}   (no longer read)`);
    out.push(`# obsolete in V2: ${key}=${value}`);
    continue;
  }
  out.push(line);
}
for (const [k, v] of Object.entries(REQUIRED)) if (!seen.has(k)) { out.push(`${k}=${v}`); report.push(`add      ${k}=${v}`); }
console.log(report.length ? report.join("\n") : "nothing to migrate — the file already runs the V2 defaults");
if (write && report.length) {
  const bak = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, bak);
  writeFileSync(path, out.join("\n"));
  console.log(`written; previous file saved as ${bak}`);
} else if (report.length) console.log(`(dry — re-run with --write to apply)`);
