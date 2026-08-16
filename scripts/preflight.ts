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
import { ALL_FACTS, assumedFacts, describe, staleFacts } from "../src/strategy/facts.js";

const cfg = loadConfig();
const report = await runPreflight({
  cfg,
  assumeMode: process.env["PRETEND_MAINNET"] === "1" ? "mainnet" : undefined,
});
console.log(formatPreflight(report));

// ── economic inputs ──────────────────────────────────────────────────────────
// Reported here rather than buried, because the two errors that inverted the
// farming verdict were both inputs going quietly stale, not code going wrong.
const stale = staleFacts();
const assumed = assumedFacts();
console.log(`\neconomic inputs: ${Object.keys(ALL_FACTS).length} facts, ` +
  `${assumed.length} assumed, ${stale.length} stale`);
for (const { name, fact } of assumed) console.log(`  ASSUMED  ${describe(name, fact)}`);
for (const s of stale) {
  console.log(`  STALE    ${s.name} — measured ${Math.floor(s.ageDays)}d ago, ` +
    `half-life ${s.halfLifeDays}d` +
    `${s.fact.provenance.kind === "measured" ? ` → ${s.fact.provenance.recheck}` : ""}`);
}
if (stale.length > 0) {
  console.log(`\n  Stale inputs are not a warning to skim. The iteration-4 pool and`);
  console.log(`  field went four days stale across a 4.7x volume collapse and made`);
  console.log(`  epoch farming read as +$35.81/day when it was negative.`);
}

process.exit(report.passed ? 0 : 1);
