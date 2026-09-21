/**
 * pnpm hold-vs-stake [wallet] [rush-usd=1000] [btc-usd=1000]
 *
 * Leave winnings UNCLAIMED as vault shares, or claim them (10% exit fee)
 * and put the RUSH in the staking treasury? Both legs, over horizons, with
 * the carry's decay as the uncertain dimension (bracketed, not picked).
 *
 *   Unclaimed shares on the Miner ARE vault shares: they earn the vault's
 *   ratio ratchet (the 10% exit fee every claimer leaves behind) until
 *   claimed. Staking pays cbBTC from the buybacks leg — a yield from volume
 *   that does not decay with claimers — but only on RUSH you have claimed,
 *   which costs 10% of it on the way out. USD is fee-free to claim: always.
 *
 * Reads the wallet's live position from the API when a wallet is given (or
 * the operator default), otherwise prices $1,000 of each leg.
 */
import { SATS_VAULT_CARRY_DAILY, STAKING_YIELD_DAILY, TOKEN_VAULT_CARRY_DAILY, V2_VAULT_EXIT_FEE_BPS } from "../src/strategy/facts.js";
const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const WALLET = process.argv[2] && !/^\d/.test(process.argv[2]) ? process.argv[2] : (process.env["OPERATOR_WALLET"] ?? "8EHb675bVwz3nrAUssQfdKx8665WjkU5wZcykvqtii5J");
const nums = process.argv.slice(2).filter((a) => /^\d/.test(a)).map(Number);
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(20_000) })).json()) as { data: T }).data;
interface Board { prices: { btc: number; token: number; sat: number; token_share: number }; sats_vault: { apr: number | null }; token_vault: { apr: number | null } }
interface Profile { miner: { unclaimed_usd_amount: string; unclaimed_sats_shares: string; unclaimed_token_shares: string } }
interface Treasury { apr: number | null }
const [board, treasury] = await Promise.all([get<Board>("board"), get<Treasury>("staking/treasury")]);
let rushUsd = nums[0] ?? 1000, btcUsd = nums[1] ?? 1000, usdUnclaimed = 0, fromWallet = false;
try {
  const p = await get<Profile>(`users/${WALLET}/profile`);
  const tokUsd = Number(p.miner.unclaimed_token_shares) * board.prices.token_share;
  const satUsd = Number(p.miner.unclaimed_sats_shares) * board.prices.sat;
  usdUnclaimed = Number(p.miner.unclaimed_usd_amount) / 1e6;
  if (tokUsd > 0 || satUsd > 0) { rushUsd = tokUsd; btcUsd = satUsd; fromWallet = true; }
} catch { /* priced hypothetically */ }
const fee = V2_VAULT_EXIT_FEE_BPS.value / 1e4;
const carryTok = TOKEN_VAULT_CARRY_DAILY.value, carrySats = SATS_VAULT_CARRY_DAILY.value, stake = STAKING_YIELD_DAILY.value;
const usd = (x: number) => `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pct = (x: number, d = 3) => `${(100 * x).toFixed(d)}%`;
console.log(`${fromWallet ? `wallet ${WALLET.slice(0, 8)}… live position` : "hypothetical position"}: RUSH shares ${usd(rushUsd)} · BTC shares ${usd(btcUsd)} · unclaimed USD ${usd(usdUnclaimed)} (claim_usd is fee-free — always claim and redeploy or withdraw)`);
console.log(`rates/day: token-vault carry ${pct(carryTok)} · sats-vault carry ${pct(carrySats)} · staking ${pct(stake)}   (app: token vault ${pct((board.token_vault.apr ?? 0) / 100 / 365)}, sats ${pct((board.sats_vault.apr ?? 0) / 100 / 365)}, staking ${pct((treasury.apr ?? 0) / 100 / 365)})`);
console.log(`exit fee ${pct(fee, 0)} on any claim of shares; staking pays in cbBTC on the RUSH claimed (net of the fee).\n`);

// Carry path: c(t) = c0 · 2^(−t/h). h = ∞ holds today's rate; h = 30/90 d models the churn drying up.
const holdValue = (v0: number, c0: number, days: number, halfLife: number): number => {
  let v = v0;
  for (let t = 0; t < days; t++) v *= 1 + c0 * (Number.isFinite(halfLife) ? Math.pow(2, -t / halfLife) : 1);
  return v;
};
const stakeValue = (v0: number, days: number): number => v0 * (1 - fee) * (1 + stake * days); // rewards paid in BTC, not restaked
console.log("RUSH leg — hold as token-vault shares vs claim (−10%) and stake, value of $" + rushUsd.toFixed(0) + " today, RUSH price held constant:");
console.log("  horizon   carry holds      carry halves/90d   carry halves/30d   claim+stake     verdict");
for (const days of [30, 90, 180, 365]) {
  const h = [holdValue(rushUsd, carryTok, days, Infinity), holdValue(rushUsd, carryTok, days, 90), holdValue(rushUsd, carryTok, days, 30)];
  const s = stakeValue(rushUsd, days);
  const worst = Math.min(...h);
  console.log(`  ${String(days).padStart(5)} d   ${usd(h[0]!).padStart(12)}   ${usd(h[1]!).padStart(16)}   ${usd(h[2]!).padStart(16)}   ${usd(s).padStart(11)}     ${s > worst ? "stake wins if the carry dies fast" : "HOLD"}`);
}
const be = stake > carryTok ? fee / (stake - carryTok) : Infinity;
console.log(`  at today's rates claim+stake ${Number.isFinite(be) ? `pays back the fee in ${be.toFixed(0)} d` : "never pays back the fee (carry ≥ staking)"}; if the carry went to zero tomorrow it would take ${(fee / stake).toFixed(0)} d.`);
console.log(`  the claim is available at the same 10% at any later date, so waiting costs nothing while the carry runs — hold, re-run this when the carry drops below ${pct(stake - fee / 365)} /day for a year-long horizon.`);
console.log(`\nBTC leg — hold as sats-vault shares (${pct(carrySats)}/day) vs claim (−10%): there is no BTC yield to switch into, so claiming only buys liquidity.`);
for (const days of [30, 90, 365]) console.log(`  ${String(days).padStart(5)} d   hold ${usd(holdValue(btcUsd, carrySats, days, Infinity))} (carry holds) … ${usd(holdValue(btcUsd, carrySats, days, 30))} (halves/30d)   vs claim now ${usd(btcUsd * (1 - fee))}`);
console.log(`\nWhat this leaves out, deliberately: RUSH price risk (identical either way), and whether the app's staking apr (${treasury.apr === null ? "n/a" : (treasury.apr).toFixed(0) + "%"}) or our lifetime average is the better forward rate — they bracket 0.15–0.22%/day.`);
