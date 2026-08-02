/**
 * Run the boot preflight gates without starting the bot.
 *
 *   pnpm preflight                     — gates at the current EXECUTION_MODE severity
 *   PRETEND_MAINNET=1 pnpm preflight   — drill: evaluate at mainnet severity
 *
 * Exit code 0 = passed, 1 = failed.
 */
import { loadConfig } from "../src/config.js";
import { formatPreflight, runPreflight } from "../src/ops/preflight.js";

const cfg = loadConfig();
const report = await runPreflight({
  cfg,
  assumeMode: process.env["PRETEND_MAINNET"] === "1" ? "mainnet" : undefined,
});
console.log(formatPreflight(report));
process.exit(report.passed ? 0 : 1);
