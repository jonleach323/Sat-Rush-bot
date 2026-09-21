/**
 * pnpm staking-yield
 *
 * What staking RUSH in the treasury pays (cbBTC from the buybacks' staking
 * share) against what holding RUSH shares in the token vault pays (the exit
 * fees of leavers). Both from the public API; the treasury figure is the
 * lifetime average since the reward stream opened, so it is a rate over the
 * whole window rather than the last day. Prints the payback horizon of
 * claiming token shares (10% exit fee) to stake them.
 */
import { TOKEN_VAULT_CARRY_DAILY, V2_VAULT_EXIT_FEE_BPS } from "../src/strategy/facts.js";
const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(20_000) })).json()) as { data: T }).data;
interface Treasury { total_staked: string; total_staked_usd: number; total_stakers: number; total_reward_deposited: string; unstreamed_reward: string; apr: number | null }
interface Board { prices: { btc: number; token: number }; token_vault: { apr: number | null } }
const [t, b] = await Promise.all([get<Treasury>("staking/treasury"), get<Board>("board")]);
const STREAM_OPENED = Date.parse(process.env["STAKING_STREAM_OPENED"] ?? "2026-09-10T17:02:00Z"); // RUSH mint created (Jupiter createdAt)
const days = (Date.now() - STREAM_OPENED) / 86400e3;
const rewardBtc = Number(t.total_reward_deposited) / 1e8;
const rewardUsd = rewardBtc * b.prices.btc;
const stakedRush = Number(t.total_staked) / 1e9;
const stakedUsd = stakedRush * b.prices.token;
const dailyUsd = rewardUsd / days;
const dailyYield = stakedUsd > 0 ? dailyUsd / stakedUsd : 0;
const pct = (x: number, d = 3) => `${(100 * x).toFixed(d)}%`;
console.log(`staking treasury: ${stakedRush.toFixed(0)} RUSH staked ($${stakedUsd.toFixed(0)} at $${b.prices.token.toFixed(2)}) by ${t.total_stakers} stakers`);
console.log(`rewards deposited since the stream opened (${days.toFixed(1)} d): ${rewardBtc.toFixed(6)} BTC = $${rewardUsd.toFixed(0)} → $${dailyUsd.toFixed(0)}/day`);
console.log(`lifetime-average staking yield: ${pct(dailyYield)}/day = ${pct(dailyYield * 365, 0)} simple APR   (app's apr field: ${t.apr === null ? "n/a" : pct(t.apr / 100, 0)})`);
console.log(`token-vault carry (fact): ${pct(TOKEN_VAULT_CARRY_DAILY.value)}/day = ${pct(TOKEN_VAULT_CARRY_DAILY.value * 365, 0)} simple APR   (app's token vault apr: ${b.token_vault.apr === null ? "n/a" : pct(b.token_vault.apr / 100, 0)})`);
const fee = V2_VAULT_EXIT_FEE_BPS.value / 1e4;
const edge = dailyYield - TOKEN_VAULT_CARRY_DAILY.value;
console.log(`claim token shares (${pct(fee, 0)} exit fee) to stake: ${edge > 0 ? `pays back the fee in ${(fee / edge).toFixed(0)} d` : "never — the vault carry is at least the staking yield"} (staking − carry = ${pct(edge)}/day)`);
console.log(`note: staking pays in cbBTC from volume (${"BUYBACKS_TO_STAKING_BPS"} of the 50 bps buybacks leg) and does not decay with claimers; the vault carry is a transfer from leavers and does. Both are before RUSH price risk, which is the same either way.`);
