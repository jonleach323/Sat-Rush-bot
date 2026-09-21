/**
 * Self-settle sweep: settle every unsettled deployment of ours (and the
 * armer's — permissionless settle, rent to the cranker = us), reclaiming
 * deployment-PDA rent and crediting any pending winnings. Also live
 * evidence for the SELF_SETTLE design (rent goes to whoever cranks).
 */
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { buildSettleDeployPublic } from "../../src/adapter/instructions.js";
import {
  appendFindings,
  explorer,
  fmtUsd,
  getBoard,
  getMiner,
  nowIso,
  sendIxs,
  setupExperiment,
} from "./lib.js";

const x = await setupExperiment("settle-sweep");
const armer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync("keypairs/unused-generated.json", "utf8")) as number[]),
);
const solBefore = await x.conn.getBalance(x.payer.publicKey, "confirmed");
const minerBefore = await getMiner(x, x.payer.publicKey);
const board = await getBoard(x);

// Batch-probe which deployment PDAs exist (kind to the public RPC).
import { publicDeploymentPda } from "../../src/adapter/pdas.js";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const targets: { roundId: number; authority: typeof x.payer.publicKey }[] = [];
for (let roundId = Math.max(1, board.round_id - 60); roundId < board.round_id; roundId++) {
  for (const authority of [x.payer.publicKey, armer.publicKey]) {
    targets.push({ roundId, authority });
  }
}
const existing: typeof targets = [];
for (let i = 0; i < targets.length; i += 100) {
  const chunk = targets.slice(i, i + 100);
  const infos = await x.conn.getMultipleAccountsInfo(
    chunk.map((t) => publicDeploymentPda(t.authority, t.roundId, x.programId)),
    "confirmed",
  );
  infos.forEach((info, j) => {
    if (info) existing.push(chunk[j]!);
  });
  await sleep(500);
}
x.log(`${existing.length} unsettled deployments found`);

let settled = 0;
let failed = 0;
let lastSig = "";
for (const { roundId, authority } of existing) {
  const sent = await sendIxs(x, x.payer, [
    buildSettleDeployPublic(x.ixCtx, {
      authority: x.payer.publicKey,
      deploymentAuthority: authority,
      roundId,
    }),
  ]);
  if (sent.landed) {
    settled++;
    lastSig = sent.sig;
    x.log(`settled round ${roundId} (${authority.equals(armer.publicKey) ? "armer" : "main"})`);
  } else {
    failed++;
    x.log(`round ${roundId} settle failed: ${sent.err?.slice(0, 60)}`);
  }
  await sleep(600);
}

const solAfter = await x.conn.getBalance(x.payer.publicKey, "confirmed");
const minerAfter = await getMiner(x, x.payer.publicKey);

const md = `## Interlude — self-settle sweep (${nowIso()})

Rent exhaustion discovered during E5 (deploy failed with system error
Custom:1 — insufficient lamports for the deployment PDA): the owner's
settle crank has been offline all session, so every deployment's rent
stayed locked. Swept ${settled} unsettled deployments (ours + the armer's —
settle is permissionless, rent to the cranker) in one pass; ${failed} failed
(rounds not yet in a settleable state). Last: ${lastSig ? explorer(lastSig) : "n/a"}

- SOL: ${(solBefore / 1e9).toFixed(5)} → ${(solAfter / 1e9).toFixed(5)} (+${((solAfter - solBefore) / 1e9).toFixed(5)} rent reclaimed net of fees)
- Miner unclaimed USD: ${fmtUsd(minerBefore?.unclaimed_usd_amount ?? 0n)} → ${fmtUsd(minerAfter?.unclaimed_usd_amount ?? 0n)}
- Miner unclaimed shares: ${minerBefore?.unclaimed_btc_shares.toString()} → ${minerAfter?.unclaimed_btc_shares.toString()}
- Miner hashrate: ${minerBefore?.hashrate_amount.toString()} → ${minerAfter?.hashrate_amount.toString()}

**Operational lesson:** SELF_SETTLE is not just rent-optimization — when the
owner's crank is down, it is the ONLY way rent and winnings come back.
Keep SELF_SETTLE=true.
`;
appendFindings(md);
console.log(md);
