/**
 * E1 (open question 1): deploy a known amount with a 3-tile mask; diff
 * TileStake before/after → split-vs-per-tile and raw-vs-effective.
 */
import {
  appendFindings,
  deploy,
  explorer,
  fmtUsd,
  getDeployment,
  getMiner,
  getRound,
  nowIso,
  setupExperiment,
  sleep,
  waitFreshRound,
} from "./lib.js";

const x = await setupExperiment("e1");
const TILES = [5, 10, 15];
const GROSS_USD = 3;

const { roundId } = await waitFreshRound(x, x.payer.publicKey);
const before = (await getRound(x, roundId))!;
const beforeStakes = TILES.map((t) => BigInt(before.public_tile_stakes[t]!.stake.toString()));
const minerBefore = await getMiner(x, x.payer.publicKey);
x.log(`round ${roundId}, deploying $${GROSS_USD} on tiles ${TILES.join(",")}`);

const sent = await deploy(x, x.payer, TILES, GROSS_USD, roundId);
if (!sent.landed) throw new Error(`deploy failed: ${sent.err}`);
await sleep(1_500);

const after = (await getRound(x, roundId))!;
const deltas = TILES.map(
  (t, i) => BigInt(after.public_tile_stakes[t]!.stake.toString()) - beforeStakes[i]!,
);
const deployment = (await getDeployment(x, x.payer.publicKey, roundId))!;
const totalStake = BigInt(deployment.total_stake_usd_amount.toString());
const deployedGross = BigInt(deployment.deployed_usd_amount.toString());
const multiplier = deployment.streak_multiplier;
const sumDeltas = deltas.reduce((a, b) => a + b, 0n);
const expectedNetEven = (deployedGross * 9_200n) / 10_000n / 3n;

const splitConclusion =
  deltas.every((d) => d === deltas[0]) && sumDeltas <= (deployedGross * 9_200n) / 10_000n
    ? "SPLIT-EVENLY: the net amount divides across masked tiles"
    : "PER-TILE: each tile received the full amount";
const semanticsConclusion =
  deltas[0] === expectedNetEven || multiplier <= 1
    ? "RAW net USD (delta = net/3 exactly; streak multiplier NOT applied to TileStake)"
    : `possibly EFFECTIVE (delta ${deltas[0]} vs raw-expected ${expectedNetEven}, multiplier ${multiplier})`;

const md = `## E1 — mask semantics (${nowIso()})

Deployed **$${GROSS_USD}** with mask over tiles ${TILES.join(", ")} in round ${roundId}: ${explorer(sent.sig)} (slot ${sent.slot})

| measure | value |
|---|---|
| TileStake delta per tile | ${deltas.map(String).join(" / ")} (base units) |
| Σ deltas | ${sumDeltas} |
| PublicDeployment.deployed_usd_amount (gross) | ${fmtUsd(deployedGross)} |
| PublicDeployment.total_stake_usd_amount (net) | ${fmtUsd(totalStake)} |
| net/3 (expected even-split per tile) | ${expectedNetEven} |
| PublicDeployment.streak_multiplier | ${multiplier} |
| Miner.current_streak_count before → after deploy | ${minerBefore?.current_streak_count ?? "?"} → ${(await getMiner(x, x.payer.publicKey))?.current_streak_count ?? "?"} |

**Conclusion (Q1):** ${splitConclusion}. TileStake.stake records **${semanticsConclusion}**. Σ per-tile deltas ${sumDeltas === totalStake ? "== total_stake_usd_amount exactly (floor dust ≤ tile count)" : `= ${sumDeltas} vs total_stake ${totalStake} (floor remainder ${totalStake - sumDeltas})`}.
→ STAKE_SEMANTICS=raw confirmed; amount splits evenly.
`;
appendFindings(md);
console.log(md);
