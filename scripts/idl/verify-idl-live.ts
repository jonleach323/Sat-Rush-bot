/**
 * Prove the generated IDL against the chain: decode the live singleton
 * accounts, the current round and our miner through OUR anchor coders, and
 * compare every field the public API also reports. Then take a recent
 * settlement transaction, pull its emit_cpi inner instruction and decode the
 * PublicDeploySettled event the same way the ingest does.
 *
 * A layout that is even one byte off decodes to garbage in a later field, and
 * the API is an independent decoder of the same bytes — so agreement here is
 * the conservation check the ground rules ask for.
 *
 *   pnpm idl:verify
 */
import bs58 from "bs58";
import { Connection, PublicKey, type AccountMeta } from "@solana/web3.js";
import {
  decodeAccount, instructionCoder, PROGRAM_ID, SATRUSH_IDL, type BN,
  type Board, type EpochVault, type Miner, type Round, type SatrushConfig, type SatsVault, type TokenVault,
} from "../../src/adapter/idl.js";
import { buildDeployPublic, buildSettleDeployPublic, type InstructionContext } from "../../src/adapter/instructions.js";
import { parseCpiEventData } from "../../src/ingest/events.js";
import {
  boardPda, epochVaultPda, minerPda, roundPda, satrushConfigPda, satsVaultPda,
} from "../../src/adapter/pdas.js";

const RPC = process.env["RPC_HTTP_URL"] ?? "https://rpc.satrush.io";
const API = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const WALLET = new PublicKey(process.env["OPERATOR_WALLET"] ?? "8EHb675bVwz3nrAUssQfdKx8665WjkU5wZcykvqtii5J");
const conn = new Connection(RPC, { commitment: "confirmed", httpHeaders: { Origin: "https://satrush.io" } });
const api = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${API}/${p}`, { headers: { "User-Agent": "curl/8" } })).json()) as { data: T }).data;
const n = (v: { toString(): string }): string => v.toString();

let failures = 0;
function check(label: string, ours: unknown, theirs: unknown): void {
  const a = String(ours), b = String(theirs);
  const ok = a === b;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(44)} ours ${a}${ok ? "" : `  api ${b}`}`);
}

// Token-vault PDA: seeds from the IDL via the generic helper the adapter exposes.
import { pdaConstSeed } from "../../src/adapter/idl.js";
const tokenVaultPda = PublicKey.findProgramAddressSync([Buffer.from(pdaConstSeed("token_vault"))], PROGRAM_ID)[0];

// API and RPC are read moments apart; a round rotating in between makes
// every round-scoped check disagree. Re-read once when the Board ids differ.
async function snapshot() {
  const [apiBoard, apiConf, apiProfile] = await Promise.all([
    api<Record<string, any>>("board"), api<Record<string, any>>("config"),
    api<{ miner: Record<string, any> }>(`users/${WALLET.toBase58()}/profile`),
  ]);
  const roundId = apiBoard["round_id"] as number;
  const keys = [boardPda(), satrushConfigPda(), satsVaultPda(), tokenVaultPda, epochVaultPda(), roundPda(roundId), minerPda(WALLET)];
  const infos = await conn.getMultipleAccountsInfo(keys, "confirmed");
  const chainRound = infos[0] ? decodeAccount<Board>("Board", infos[0].data).round_id : -1;
  return { apiBoard, apiConf, apiProfile, roundId, infos, consistent: chainRound === roundId };
}
let snap = await snapshot();
if (!snap.consistent) { console.log("  (round rotated between API and RPC reads — re-reading)"); snap = await snapshot(); }
const { apiBoard, apiConf, apiProfile, roundId, infos } = snap;
const need = (i: number, name: string): Buffer => { const x = infos[i]; if (!x) throw new Error(`${name} account missing`); return x.data; };

console.log(`══ decoding live accounts through the generated IDL (${RPC}) ══`);
const board = decodeAccount<Board>("Board", need(0, "Board"));
check("Board.round_id", board.round_id, roundId);
check("Board.round_duration", board.round_duration, apiBoard["round_duration"]);
check("Board.strike_usd_amount", n(board.strike_usd_amount), apiBoard["strike"]["usd_amount"]);
check("Board.strike_btc_amount", n(board.strike_btc_amount), apiBoard["strike"]["btc_amount"]);
check("Board.strike_token_amount", n(board.strike_token_amount), apiBoard["strike"]["token_amount"]);
check("Board.strike_last_trigger_round_id", board.strike_last_trigger_round_id, apiBoard["strike"]["last_trigger_round_id"]);

const conf = decodeAccount<SatrushConfig>("SatrushConfig", need(1, "SatrushConfig"));
const ixCtx: InstructionContext = { usdMint: conf.usd_mint, btcMint: conf.btc_mint, tokenMint: conf.token_mint };
for (const f of ["strike_fee_bps", "epoch_fee_bps", "one_btc_fee_bps", "protocol_fee_bps", "vault_exit_fee_bps", "unclaimed_hashrate_bps", "sats_vault_round_fee_bps"] as const) {
  check(`SatrushConfig.${f}`, conf[f], apiConf[f]);
}
check("SatrushConfig.min_deploy_usd_amount", n(conf.min_deploy_usd_amount), apiConf["min_deploy_usd_amount"]);
check("SatrushConfig.epoch_vault_iteration_duration", n(conf.epoch_vault_iteration_duration), apiConf["epoch_vault_iteration_duration"]);
check("SatrushConfig.token_mint", conf.token_mint.toBase58(), apiConf["token_mint"]);
check("SatrushConfig.usd_mint", conf.usd_mint.toBase58(), apiConf["usd_mint"]);
console.log(`  info buybacks_fee_bps (not served by the API): ${conf.buybacks_fee_bps} · strike_trigger_modulus ${conf.strike_trigger_modulus}`);

const sats = decodeAccount<SatsVault>("SatsVault", need(2, "SatsVault"));
check("SatsVault.btc_amount", n(sats.btc_amount), apiBoard["sats_vault"]["btc_amount"]);
check("SatsVault.btc_shares", n(sats.btc_shares), apiBoard["sats_vault"]["btc_shares"]);
const tv = decodeAccount<TokenVault>("TokenVault", need(3, "TokenVault"));
check("TokenVault.token_amount", n(tv.token_amount), apiBoard["token_vault"]["token_amount"]);
check("TokenVault.token_shares", n(tv.token_shares), apiBoard["token_vault"]["token_shares"]);
const ev = decodeAccount<EpochVault>("EpochVault", need(4, "EpochVault"));
check("EpochVault.iteration_id", ev.iteration_id, apiBoard["epoch_vault"]["iteration_id"]);
check("EpochVault.pool_usd_amount", n(ev.pool_usd_amount), apiBoard["epoch_vault"]["pool_usd_amount"]);
check("EpochVault.pool_token_amount", n(ev.pool_token_amount), apiBoard["epoch_vault"]["pool_token_amount"]);

const round = decodeAccount<Round>("Round", need(5, "Round"));
const ar = apiBoard["active_round"] as Record<string, any>;
check("Round.id", round.id, ar["id"]);
check("Round.state", Object.keys(round.state)[0]?.toLowerCase(), ar["state"]);
check("Round.miners_count", round.miners_count, ar["miners_count"]);
check("Round.deployed_pending_usd_amount", n(round.deployed_pending_usd_amount), ar["deployed_pending_usd_amount"]);
check("Round.deployed_gross_usd_amount", n(round.deployed_gross_usd_amount), ar["total_gross_deployed_usd"]);
check("Round.public_tile_stakes.length", round.public_tile_stakes.length, 21);
check("Round.tile[0].stake", n(round.public_tile_stakes[0]!.stake), ar["tile_stakes"][0]["stake"]);
check("Round.is_hashrate_boosted", round.is_hashrate_boosted, ar["is_hashrate_boosted"]);

const miner = decodeAccount<Miner>("Miner", need(6, "Miner"));
const m = apiProfile.miner;
check("Miner.unclaimed_btc_shares", n(miner.unclaimed_btc_shares), m["unclaimed_sats_shares"]);
check("Miner.unclaimed_token_shares", n(miner.unclaimed_token_shares), m["unclaimed_token_shares"]);
check("Miner.hashrate_amount", n(miner.hashrate_amount), m["hashrate_amount"]);
check("Miner.unclaimed_hashrate", n(miner.unclaimed_hashrate), m["unclaimed_hashrate_amount"]);
check("Miner.current_streak_count", miner.current_streak_count, m["current_streak_count"]);
check("Miner.last_mined_round_id", miner.last_mined_round_id, m["last_mined_round_id"]);
check("Miner.affiliate is default", miner.affiliate.equals(PublicKey.default), m["affiliate"] === null);

// ── live transactions: events decoded the way the ingest decodes them, and
// our instruction builders diffed key-for-key against what actually landed ──
console.log(`\n══ live transactions of the previous round ══`);
const prev = apiBoard["previous_round"] as Record<string, any>;
const detail = await api<{ deployments: Record<string, any>[] }>(`rounds/${prev["id"]}`);
const settledDeploys = detail.deployments.filter((d) => d["settled_at"]);
if (settledDeploys.length === 0) throw new Error("no settled deployment in the previous round yet");
// Event + settle diff: any settled deployment of the previous round. Deploy
// diff: a direct (non-automation) deployment, searched back a few rounds —
// automations go through execute_public_automation, not deploy_public.
const pick = settledDeploys.find((d) => !d["is_automation"]) ?? settledDeploys[0]!;
const authority = new PublicKey(pick["authority"] as string);
const deploymentPda = new PublicKey(pick["deployment"] as string);
console.log(`  round ${prev["id"]} deployer ${authority.toBase58().slice(0, 8)}… automation=${pick["is_automation"]}`);
let direct: { roundId: number; deployment: Record<string, any> } | null = pick["is_automation"] ? null : { roundId: prev["id"] as number, deployment: pick };
for (let r = (prev["id"] as number) - 1; direct === null && r > (prev["id"] as number) - 12; r--) {
  const d = await api<{ deployments: Record<string, any>[] }>(`rounds/${r}`);
  const hit = d.deployments.find((x) => !x["is_automation"]);
  if (hit) direct = { roundId: r, deployment: hit };
}
console.log(`  direct deploy to diff: ${direct ? `round ${direct.roundId} by ${String(direct.deployment["authority"]).slice(0, 8)}…` : "none in the last 12 rounds"}`);

const discr = new Map(SATRUSH_IDL.instructions.map((ix) => [Buffer.from(ix.discriminator).toString("hex"), ix.name]));
const flag = (k: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }): string =>
  `${k.pubkey.toBase58()}${k.isWritable ? "*" : ""}${k.isSigner ? "!" : ""}`;

function diffKeys(label: string, ours: AccountMeta[], live: AccountMeta[]): void {
  // A pubkey that appears twice in a message carries the union of its flags,
  // so a non-signer slot filled with the signer's own key shows up signed.
  const ourSigners = new Set(ours.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()));
  const a = ours.map((k) => flag({ ...k, isSigner: k.isSigner || ourSigners.has(k.pubkey.toBase58()) }));
  const b = live.map(flag);
  const bad = a.length !== b.length ? [`length ours ${a.length} live ${b.length}`] : [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) bad.push(`[${i}] ours ${a[i] ?? "—"} live ${b[i] ?? "—"}`);
  }
  if (bad.length === 0) { console.log(`  ok   ${label}: ${a.length} accounts identical`); return; }
  failures++;
  console.log(`  FAIL ${label}:\n         ${bad.join("\n         ")}`);
}

const tapes: { pda: PublicKey; roundId: number; authority: PublicKey }[] = [{ pda: deploymentPda, roundId: prev["id"] as number, authority }];
if (direct && !new PublicKey(direct.deployment["deployment"] as string).equals(deploymentPda)) {
  tapes.push({ pda: new PublicKey(direct.deployment["deployment"] as string), roundId: direct.roundId, authority: new PublicKey(direct.deployment["authority"] as string) });
}
let eventFound = false;
const seenIx = new Set<string>();
for (const tape of tapes) for (const sgn of await conn.getSignaturesForAddress(tape.pda, { limit: 5 }, "confirmed")) {
  const tx = await conn.getTransaction(sgn.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx?.meta) continue;
  const keys = tx.transaction.message.getAccountKeys(tx.meta.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : undefined);
  const msg = tx.transaction.message;

  // outer program instructions → builder diff
  for (const ix of msg.compiledInstructions) {
    if (!keys.get(ix.programIdIndex)?.equals(PROGRAM_ID)) continue;
    const data = Buffer.from(ix.data);
    const name = discr.get(data.subarray(0, 8).toString("hex")) ?? "?";
    const live: AccountMeta[] = ix.accountKeyIndexes.map((i) => ({
      pubkey: keys.get(i)!,
      isSigner: msg.isAccountSigner(i),
      isWritable: msg.isAccountWritable(i),
    }));
    const signer = live[0]!.pubkey;
    if (name === "deploy_public" && !seenIx.has(name)) {
      seenIx.add(name);
      const args = instructionCoder.decode(data)!.data as { selection_mask: number; amount: BN; is_grubstake_funded: boolean };
      const affPos = SATRUSH_IDL.instructions.find((i) => i.name === name)!.accounts.findIndex((a) => a.name === "affiliate");
      const liveAff = live[affPos]!.pubkey;
      // The affiliate slot is the affiliate PDA; the builder takes the affiliate's
      // authority, which the tape does not carry, so diff that slot by value.
      const ours = buildDeployPublic(ixCtx, {
        authority: signer,
        roundId: tape.roundId,
        selectionMask: args.selection_mask,
        amountBaseUnits: BigInt(args.amount.toString()),
        isGrubstakeFunded: args.is_grubstake_funded,
      });
      if (!liveAff.equals(PROGRAM_ID)) ours.keys[affPos] = { pubkey: liveAff, isSigner: false, isWritable: live[affPos]!.isWritable };
      console.log(`  tx ${sgn.signature} deploy_public mask ${args.selection_mask} amount ${args.amount.toString()} grubstake ${args.is_grubstake_funded} affiliate ${liveAff.equals(PROGRAM_ID) ? "none" : "set"}`);
      diffKeys("buildDeployPublic vs live", ours.keys, live);
    } else if (name === "settle_deploy_public" && !seenIx.has(name)) {
      const idlAcc = SATRUSH_IDL.instructions.find((i) => i.name === name)!.accounts;
      const pos = (n: string): number => idlAcc.findIndex((a) => a.name === n);
      // The tape may carry several settles per tx; find ours by deployment.
      if (!live[pos("public_deployment")]!.pubkey.equals(tape.pda)) continue;
      seenIx.add(name);
      const liveAff = live[pos("affiliate")]!.pubkey;
      const ours = buildSettleDeployPublic(ixCtx, {
        authority: signer,
        deploymentAuthority: tape.authority,
        roundId: tape.roundId,
        rentRecipient: live[pos("rent_recipient")]!.pubkey,
        affiliate: liveAff.equals(PROGRAM_ID) ? undefined : liveAff,
      });
      console.log(`  tx ${sgn.signature} settle_deploy_public cranked by ${signer.toBase58().slice(0, 8)}… affiliate ${liveAff.equals(PROGRAM_ID) ? "none" : "set"}`);
      diffKeys("buildSettleDeployPublic vs live", ours.keys, live);
    } else if (!seenIx.has(name)) {
      seenIx.add(name);
      console.log(`  info tx ${sgn.signature} ${name} (${live.length} accounts; no builder to diff)`);
    }
  }

  // inner emit_cpi instructions → event decode
  for (const grp of tx.meta.innerInstructions ?? []) {
    for (const ix of grp.instructions) {
      if (!keys.get(ix.programIdIndex)?.equals(PROGRAM_ID)) continue;
      const ev = parseCpiEventData(bs58.decode(ix.data), tx.slot, sgn.signature);
      if (!ev || ev.name !== "PublicDeploySettled") continue;
      const e = ev.data as Record<string, any>;
      if (!(e["authority"] as PublicKey).equals(authority) || tape.pda !== deploymentPda) continue;
      eventFound = true;
      console.log(`  tx ${sgn.signature} PublicDeploySettled round ${e["round_id"]}`);
      check("event.winning_stake", n(e["winning_stake"]), pick["winning_usd_stake_amount"]);
      check("event.won_usd_amount", n(e["won_usd_amount"]), pick["usd_earned"]);
      check("event.won_shares_amount", n(e["won_shares_amount"]), pick["sats_shares_earned"]);
      check("event.won_token_amount", n(e["won_token_amount"]), pick["token_earned"]);
      check("event.won_token_shares", n(e["won_token_shares"]), pick["token_shares_earned"]);
      check("event.hashrate_earned", n(e["hashrate_earned"]), pick["hashrate_earned"]);
      check("event.is_grubstake_funded", e["is_grubstake_funded"], pick["is_grubstake_funded"]);
    }
  }
}
if (!eventFound) { failures++; console.log("  FAIL no PublicDeploySettled event for this deployer in the deployment's recent transactions"); }
if (!seenIx.has("deploy_public")) { failures++; console.log("  FAIL no deploy_public instruction found to diff the builder against"); }
if (!seenIx.has("settle_deploy_public")) { failures++; console.log("  FAIL no settle_deploy_public instruction found to diff the builder against"); }

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
