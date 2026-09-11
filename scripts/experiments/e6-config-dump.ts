/** E6: dump SatrushConfig + SatsVault + Board; resolve mint identities. */
import { boardPda } from "../../src/adapter/pdas.js";
import { decodeAccount, type Board } from "../../src/adapter/idl.js";
import {
  appendFindings,
  fmtUsd,
  getVault,
  nowIso,
  setupExperiment,
  U64_MAX,
} from "./lib.js";

const x = await setupExperiment("e6");
const c = x.satrushConfig;
const vault = await getVault(x);
const boardInfo = await x.conn.getAccountInfo(boardPda(x.programId), "confirmed");
const board = decodeAccount<Board>("Board", boardInfo!.data);

async function mintInfo(mint: typeof c.usd_mint) {
  const info = await x.conn.getParsedAccountInfo(mint, "confirmed");
  const data = info.value?.data;
  if (data && typeof data === "object" && "parsed" in data) {
    const parsed = (data as { parsed: { info: { decimals: number; supply: string } } })
      .parsed.info;
    return { decimals: parsed.decimals, supply: parsed.supply };
  }
  return { decimals: -1, supply: "?" };
}
const usdMint = await mintInfo(c.usd_mint);
const btcMint = await mintInfo(c.btc_mint);
const endSlot = BigInt(board.end_slot.toString());

const md = `## E6 — on-chain config dump (${nowIso()})

| field | value |
|---|---|
| usd_mint | \`${c.usd_mint.toBase58()}\` (decimals ${usdMint.decimals}) |
| btc_mint | \`${c.btc_mint.toBase58()}\` (decimals ${btcMint.decimals}, supply ${btcMint.supply}) |
| strike_fee_bps | ${c.strike_fee_bps} |
| epoch_fee_bps | ${c.epoch_fee_bps} |
| one_btc_fee_bps | ${c.one_btc_fee_bps} |
| sats_vault_round_fee_bps | ${c.sats_vault_round_fee_bps} |
| vault_exit_fee_bps | ${c.vault_exit_fee_bps} |
| protocol_fee_bps | ${c.protocol_fee_bps} |
| unclaimed_hashrate_bps | ${c.unclaimed_hashrate_bps} |
| min_deploy_usd_amount | ${fmtUsd(c.min_deploy_usd_amount)} |
| epoch_vault_iteration_duration | ${c.epoch_vault_iteration_duration.toString()} slots |
| deployment_settle_grace_duration | ${c.deployment_settle_grace_duration.toString()} slots |
| strike_trigger_modulus | ${c.strike_trigger_modulus} |
| game_authority | \`${c.game_authority.toBase58()}\` |
| board.round_id | ${board.round_id} (duration ${board.round_duration} slots) |
| board clock | ${endSlot === U64_MAX ? "DISARMED (u64::MAX until first deploy)" : `start ${board.start_slot} end ${board.end_slot}`} |
| strike pool | ${fmtUsd(board.strike_usd_amount)} swapped + ${fmtUsd(board.strike_pending_usd_amount)} pending, ${board.strike_btc_amount.toString()} BTC units |
| strike last trigger | round ${board.strike_last_trigger_round_id} |
| sats vault | btc ${vault.btc_amount.toString()} / shares ${vault.btc_shares.toString()} / leftovers ${vault.leftovers.toString()} |

**Conclusion (Q6):** deploy legs = 264+262+132+142 = 800 bps; sats-vault round leg 1200 bps at pot swap; claim fee 1000 bps; 35% hashrate deferral; $1 min deploy; 50-slot rounds. Total per-cycle fee load ≈ 20% of gross before claim fees.
`;
appendFindings(md);
console.log(md);
