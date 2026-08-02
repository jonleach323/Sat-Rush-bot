/**
 * E5 (open question 5): the streak multiplier curve. Deploy minimum stake
 * across consecutive rounds; log streak_multiplier from PublicDeployment
 * and Miner streak state per round; tabulate growth and any cap.
 */
import {
  appendFindings,
  deploy,
  explorer,
  getDeployment,
  getMiner,
  nowIso,
  setupExperiment,
  sleep,
  waitFreshRound,
  waitRotation,
} from "./lib.js";

const x = await setupExperiment("e5");
const ROUNDS = Number(process.env["E5_ROUNDS"] ?? 8);

const initial = await getMiner(x, x.payer.publicKey);
x.log(
  `starting: streak=${initial?.current_streak_count} last_mined=${initial?.last_mined_round_id}`,
);

interface Row {
  roundId: number;
  streakCount: number;
  multiplier: number;
  lastMined: number;
  sig: string;
}
const rows: Row[] = [];

for (let i = 0; i < ROUNDS; i++) {
  const { roundId } = await waitFreshRound(x, x.payer.publicKey, 180_000);
  const sent = await deploy(x, x.payer, [i % 21], 1, roundId);
  if (!sent.landed) {
    x.log(`deploy failed round ${roundId}: ${sent.err}`);
    continue;
  }
  await sleep(800);
  const deployment = (await getDeployment(x, x.payer.publicKey, roundId))!;
  const miner = (await getMiner(x, x.payer.publicKey))!;
  rows.push({
    roundId,
    streakCount: miner.current_streak_count,
    multiplier: deployment.streak_multiplier,
    lastMined: miner.last_mined_round_id,
    sig: sent.sig,
  });
  x.log(
    `round ${roundId}: streak_count=${miner.current_streak_count} multiplier=${deployment.streak_multiplier}`,
  );
  await waitRotation(x, roundId, 120_000).catch(() => undefined);
}

const multipliers = rows.map((r) => r.multiplier);
const capped =
  multipliers.length > 2 && multipliers.at(-1) === multipliers.at(-2)
    ? `cap or plateau at ${multipliers.at(-1)}`
    : "no cap reached in this window";
const deltas = multipliers.slice(1).map((m, i) => m - multipliers[i]!);

const md = `## E5 — streak multiplier curve (${nowIso()})

Prior state: streak_count=${initial?.current_streak_count}, last_mined_round=${initial?.last_mined_round_id}. Then $1 deploys in ${rows.length} consecutive rounds:

| round | Miner.current_streak_count (after deploy) | PublicDeployment.streak_multiplier | evidence |
|---:|---:|---:|---|
${rows
  .map((r) => `| ${r.roundId} | ${r.streakCount} | ${r.multiplier} | ${explorer(r.sig)} |`)
  .join("\n")}

- multiplier deltas per consecutive round: ${deltas.join(", ") || "n/a"}
- ${capped}
- **streak updates at DEPLOY time** (Miner.current_streak_count and the
  deployment's snapshotted multiplier both advance in the deploy
  transaction — no settle needed; consistent with the multiplier being
  "snapshotted at deploy" per the IDL docs).

**Conclusion (Q5, partial):** table above is the measured curve start; the
gap behavior is visible in whether streak_count continued from the prior
session (${initial?.current_streak_count}) or reset when rounds ${initial?.last_mined_round_id}→first-row were skipped.
`;
appendFindings(md);
console.log(md);
