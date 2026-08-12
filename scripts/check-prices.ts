/**
 * Ops check: is the price oracle actually wired up on this box?
 *
 * Prints the live BTC/SOL quotes and whether each is a real oracle read or a
 * cold-start fallback. `live: false` means every BTC-denominated figure the bot
 * reports (vault pools, unclaimed position value) and its Jito tip sizing are
 * running on a guess — worth knowing before, not after.
 *
 *   pnpm exec tsx scripts/check-prices.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { PriceFeed } from "../src/ingest/prices.js";

const cfg = loadConfig();
const connection = new Connection(cfg.RPC_HTTP_URL, "processed");
const feed = new PriceFeed({
  connection,
  accounts: {
    btc: cfg.PYTH_BTC_USD_ACCOUNT ? new PublicKey(cfg.PYTH_BTC_USD_ACCOUNT) : undefined,
    sol: cfg.PYTH_SOL_USD_ACCOUNT ? new PublicKey(cfg.PYTH_SOL_USD_ACCOUNT) : undefined,
  },
  fallback: { btc: cfg.BTC_USD_ESTIMATE, sol: cfg.SOL_USD_ESTIMATE },
  maxStaleSlots: cfg.PRICE_MAX_STALE_SLOTS,
  maxConfidenceRatio: cfg.PRICE_MAX_CONFIDENCE_RATIO,
  log: (obj, msg) => console.error("REJECTED:", msg, JSON.stringify(obj)),
});

await feed.refresh();
const s = feed.status();
for (const [sym, v] of Object.entries(s)) {
  const tag = v.live ? "live (pyth)" : "FALLBACK — not live";
  console.log(`${sym.toUpperCase()}/USD  ${v.usd.toFixed(sym === "btc" ? 2 : 4)}  ${tag}`);
}
process.exit(s.btc.live && s.sol.live ? 0 : 1);
