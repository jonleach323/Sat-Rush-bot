/**
 * E2 (open question 2): can a wallet deploy twice in one round
 * (accumulate), or is it one-shot? Deploy, then attempt a second deploy in
 * the same round and record the exact outcome.
 */
import {
  appendFindings,
  deploy,
  explorer,
  getDeployment,
  fmtUsd,
  nowIso,
  setupExperiment,
  sleep,
  waitFreshRound,
} from "./lib.js";

const x = await setupExperiment("e2");
const { roundId } = await waitFreshRound(x, x.payer.publicKey);

x.log(`round ${roundId}: first deploy $1 on tile 2`);
const first = await deploy(x, x.payer, [2], 1, roundId);
if (!first.landed) throw new Error(`first deploy failed: ${first.err}`);
await sleep(1_000);

x.log("second deploy $1 on tile 7 — same round");
const second = await deploy(x, x.payer, [7], 1, roundId);
await sleep(1_000);
const deployment = (await getDeployment(x, x.payer.publicKey, roundId))!;

const programLog =
  second.logs.filter((l) => l.includes("Error") || l.includes("failed") || l.includes("already"))
    .slice(0, 4)
    .join("\n> ") || "(no error lines)";

const md = `## E2 — double deploy in one round (${nowIso()})

Round ${roundId}: first deploy ${explorer(first.sig)} landed (slot ${first.slot}). Second deploy attempt ${explorer(second.sig)}:

- outcome: **${second.landed ? "LANDED — deploys accumulate!" : "FAILED"}**
- error: \`${second.err ?? "none"}\`
- program log:
> ${programLog}
- PublicDeployment after both attempts: gross ${fmtUsd(deployment.deployed_usd_amount)}, net ${fmtUsd(deployment.total_stake_usd_amount)}, mask ${deployment.selection_mask}

**Conclusion (Q2):** ${
  second.landed
    ? "a wallet CAN deploy multiple times per round — amounts/masks accumulate as shown above."
    : "one-shot per round confirmed: the PublicDeployment PDA is round-seeded and the second create fails (see error). Deploy sizing must be final at fire time — no topping up after more information arrives."
}
`;
appendFindings(md);
console.log(md);
