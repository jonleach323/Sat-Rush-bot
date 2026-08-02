/**
 * E3 (open questions 3 + 7): Discretionary automation behavior.
 *  1. Create a Discretionary automation with a minimal budget; do NOT
 *     execute — watch whether the owner's crank fires it (idle and active
 *     rounds), and with what mask.
 *  2. execute_public_automation with Some(mask) as the authority.
 *  3. The same from a second throwaway keypair (mask authority-gating).
 *  4. reload: check whether winnings compound into the automation ATA.
 * Cancels the automation at the end to reclaim the escrow.
 */
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { tilesToMask } from "../../src/adapter/mask.js";
import { publicAutomationPda } from "../../src/adapter/pdas.js";
import type { PublicDeployCreated } from "../../src/adapter/idl.js";
import { usdToBase } from "../../src/units.js";
import {
  appendFindings,
  buildCancelAutomation,
  buildCreateAutomation,
  buildExecuteAutomation,
  buildTopUpAutomation,
  deploy,
  explorer,
  fmtUsd,
  getAutomation,
  getBoard,
  getDeployment,
  nowIso,
  recentProgramEvents,
  sendIxs,
  setupExperiment,
  sleep,
  waitFreshRound,
  waitRotation,
} from "./lib.js";

const x = await setupExperiment("e3");
const me = x.payer.publicKey;
const evidence: string[] = [];
const note = (s: string) => {
  x.log(s);
  evidence.push(`- ${s}`);
};

const armer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync("keypairs/unused-generated.json", "utf8")) as number[],
  ),
);
if (!existsSync("keypairs/unused-generated.json")) throw new Error("armer missing");

// ── 1. create Discretionary automation, deposit $2, top up $1 ───────────────
const existing = await getAutomation(x, me);
if (!existing) {
  const create = await sendIxs(x, x.payer, [
    buildCreateAutomation(x, me, {
      strategy: "Discretionary",
      selectionMask: 0,
      perRoundUsd: usdToBase(1),
      reload: true,
      depositUsd: usdToBase(2),
    }),
  ]);
  if (!create.landed) throw new Error(`create failed: ${create.err} ${create.logs.slice(-4).join("|")}`);
  note(`created Discretionary automation (mask 0, $1/round, reload, $2 deposit): ${explorer(create.sig)}`);
  const topUp = await sendIxs(x, x.payer, [buildTopUpAutomation(x, me, usdToBase(1))]);
  note(`top_up $1 → ${topUp.landed ? "ok" : `failed: ${topUp.err}`}: ${explorer(topUp.sig)}`);
} else {
  note(`automation already exists (remaining ${fmtUsd(existing.remaining_usd_amount)}) — reusing`);
}
const automationPda = publicAutomationPda(me, x.programId);
const automationAta = getAssociatedTokenAddressSync(x.ixCtx.usdMint, automationPda, true);

// ── 2. observe: does the crank execute a Discretionary unprompted? ──────────
async function automationDeployObserved(sinceRound: number): Promise<PublicDeployCreated | null> {
  const events = await recentProgramEvents(x, 20);
  for (const e of events) {
    if (e.name !== "PublicDeployCreated") continue;
    const d = e.data as PublicDeployCreated;
    if (d.is_automation && d.authority.equals(me) && d.round_id >= sinceRound) return d;
  }
  return null;
}

const board0 = await getBoard(x);
note(`observing idle board (round ${board0.round_id}) for 90s — does the crank fire the automation with no activity?`);
let crankFired: PublicDeployCreated | null = null;
for (let i = 0; i < 6 && !crankFired; i++) {
  await sleep(15_000);
  crankFired = await automationDeployObserved(board0.round_id);
}
note(
  crankFired
    ? `CRANK FIRED on idle board: round ${crankFired.round_id}, mask ${crankFired.selection_mask}`
    : "crank did NOT execute the Discretionary automation on an idle board (90s window)",
);

if (!crankFired) {
  // Arm a round with the second wallet and observe an ACTIVE round.
  const { roundId } = await waitFreshRound(x, me);
  const arm = await deploy(x, armer, [19], 1, roundId);
  note(`armed round ${roundId} via second wallet: ${explorer(arm.sig)} — observing the active round`);
  for (let i = 0; i < 4 && !crankFired; i++) {
    await sleep(6_000);
    crankFired = await automationDeployObserved(roundId);
  }
  note(
    crankFired
      ? `CRANK FIRED during active round ${crankFired.round_id}, mask ${crankFired.selection_mask}`
      : `crank did NOT execute the automation during active round ${roundId} either`,
  );
  await waitRotation(x, roundId, 90_000).catch(() => undefined);
}

// ── 3. self-execute with Some(mask) ──────────────────────────────────────────
const fresh1 = await waitFreshRound(x, me);
{
  const arm = await deploy(x, armer, [18], 1, fresh1.roundId).catch(() => null);
  if (arm?.landed) note(`armed round ${fresh1.roundId} for self-execute test: ${explorer(arm.sig)}`);
}
const selfMask = tilesToMask([7]);
const selfExec = await sendIxs(x, x.payer, [
  buildExecuteAutomation(x, me, me, fresh1.roundId, selfMask),
]);
const selfDeployment = await getDeployment(x, me, fresh1.roundId);
note(
  `self execute_public_automation Some(mask=${selfMask}) round ${fresh1.roundId}: ` +
    `${selfExec.landed ? `LANDED — deployment mask ${selfDeployment?.selection_mask}, automation-linked ${selfDeployment?.automation !== null}` : `FAILED: ${selfExec.err} | ${selfExec.logs.filter((l) => l.includes("Error")).join(" | ")}`} ${explorer(selfExec.sig)}`,
);
await waitRotation(x, fresh1.roundId, 90_000).catch(() => undefined);

// ── 4. stranger-execute with Some(mask) from the second keypair ─────────────
const fresh2 = await waitFreshRound(x, me);
const strangerMask = tilesToMask([9]);
const strangerExec = await sendIxs(x, armer, [
  buildExecuteAutomation(x, armer.publicKey, me, fresh2.roundId, strangerMask),
]);
const strangerDeployment = await getDeployment(x, me, fresh2.roundId);
note(
  `stranger execute Some(mask=${strangerMask}) round ${fresh2.roundId}: ` +
    `${strangerExec.landed ? `LANDED — mask used ${strangerDeployment?.selection_mask} (${strangerDeployment?.selection_mask === strangerMask ? "stranger's mask ACCEPTED — not authority-gated!" : "mask ignored/replaced"})` : `FAILED: ${strangerExec.err} | ${strangerExec.logs.filter((l) => l.includes("Error")).slice(0, 2).join(" | ")}`} ${explorer(strangerExec.sig)}`,
);
// stranger with None for completeness
const strangerNone = await sendIxs(x, armer, [
  buildExecuteAutomation(x, armer.publicKey, me, fresh2.roundId, null),
]);
note(
  `stranger execute None same round: ${strangerNone.landed ? "LANDED" : `failed: ${strangerNone.err}`} ${explorer(strangerNone.sig)}`,
);

// ── 5. reload observation + cancel ───────────────────────────────────────────
const ataBefore = await x.conn
  .getTokenAccountBalance(automationAta, "confirmed")
  .then((r) => r.value.amount)
  .catch(() => "0");
const auto = await getAutomation(x, me);
note(
  `automation state pre-cancel: remaining ${auto ? fmtUsd(auto.remaining_usd_amount) : "?"}, total_spent ${auto ? fmtUsd(auto.total_spent_usd_amount) : "?"}, escrow ATA ${fmtUsd(BigInt(ataBefore))} — reload compounding ${auto && BigInt(ataBefore) > BigInt(auto.remaining_usd_amount.toString()) ? "OBSERVED (ATA > remaining)" : "not observed in this window (no automation win settled)"}`,
);
const cancel = await sendIxs(x, x.payer, [buildCancelAutomation(x, me)]);
note(`cancel_public_automation: ${cancel.landed ? "escrow reclaimed" : `failed: ${cancel.err}`} ${explorer(cancel.sig)}`);

const md = `## E3 — Discretionary automation behavior (${nowIso()})

${evidence.join("\n")}

**Conclusions (Q3/Q7):**
- Crank preemption: ${crankFired ? `the owner's crank DOES execute Discretionary automations unprompted (mask ${crankFired.selection_mask})` : "the crank did NOT execute the Discretionary automation in the observed windows — Discretionary appears to wait for the authority (or crank scheduling is much slower than round cadence)"}.
- Authority self-execute with Some(mask): see evidence line above.
- Stranger execute: see evidence lines — this decides whether Discretionary masks are authority-gated.
- reload compounding: not conclusively observed unless an automation deployment won during the window (see evidence).
`;
appendFindings(md);
console.log(md);
