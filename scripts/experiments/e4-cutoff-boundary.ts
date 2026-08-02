/**
 * E4 (open question 4): the empirical RoundNotActive boundary. Fire
 * deploys at descending slotsToCutoff (8,6,4,3,2,1,0) — a second throwaway
 * wallet arms each round first (one deploy per wallet per round). Records
 * which land vs 6005 and outputs the empirical FIRE_OFFSET_SLOTS floor.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { existsSync, readFileSync } from "node:fs";
import { buildDeployPublic } from "../../src/adapter/instructions.js";
import { tilesToMask } from "../../src/adapter/mask.js";
import { assembleTx } from "../../src/exec/tx.js";
import { confirmSignature, isRoundNotActive } from "../../src/exec/confirm.js";
import { usdToBase } from "../../src/units.js";
import {
  appendFindings,
  deploy,
  explorer,
  getBoard,
  nowIso,
  sendIxs,
  setupExperiment,
  sleep,
  waitFreshRound,
  waitRotation,
} from "./lib.js";

const x = await setupExperiment("e4");
const OFFSETS = [8, 6, 4, 3, 2, 1, 0];

// ── fund the armer wallet (SOL for fees/rent, USDC for $1 arms) ─────────────
const armerPath = "keypairs/unused-generated.json";
if (!existsSync(armerPath)) throw new Error("armer keypair missing");
const armer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(armerPath, "utf8")) as number[]),
);
x.log(`armer wallet ${armer.publicKey.toBase58()}`);
const armerUsdAta = getAssociatedTokenAddressSync(x.ixCtx.usdMint, armer.publicKey);
const armerSol = await x.conn.getBalance(armer.publicKey, "confirmed");
if (armerSol < 25_000_000) {
  const fund = await sendIxs(x, x.payer, [
    SystemProgram.transfer({
      fromPubkey: x.payer.publicKey,
      toPubkey: armer.publicKey,
      lamports: 30_000_000,
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      x.payer.publicKey,
      armerUsdAta,
      armer.publicKey,
      x.ixCtx.usdMint,
    ),
    createTransferInstruction(
      getAssociatedTokenAddressSync(x.ixCtx.usdMint, x.payer.publicKey),
      armerUsdAta,
      x.payer.publicKey,
      Number(usdToBase(10)),
    ),
  ]);
  if (!fund.landed) throw new Error(`armer funding failed: ${fund.err}`);
  x.log(`armer funded: ${fund.sig.slice(0, 16)}`);
}

// ── one probe per round ──────────────────────────────────────────────────────
interface ProbeResult {
  offset: number;
  roundId: number;
  sentAtCutoff: number;
  landedSlot: number | null;
  endSlot: number;
  outcome: string;
  sig: string;
}
const results: ProbeResult[] = [];

for (const offset of OFFSETS) {
  const { roundId } = await waitFreshRound(x, x.payer.publicKey, 180_000);
  // Arm the round with the second wallet.
  const arm = await deploy(x, armer, [20], 1, roundId);
  if (!arm.landed) {
    x.log(`arm failed for round ${roundId}: ${arm.err} — waiting for rotation`);
    await waitRotation(x, roundId).catch(() => undefined);
    continue;
  }
  const board = await getBoard(x);
  const endSlot = Number(board.end_slot.toString());
  x.log(`round ${roundId} armed, end_slot ${endSlot}; targeting cutoff ${offset}`);

  // Pre-sign our probe so firing is pure wire-write.
  const ix = buildDeployPublic(x.ixCtx, {
    authority: x.payer.publicKey,
    roundId,
    selectionMask: tilesToMask([offset === 0 ? 1 : offset]),
    amountBaseUnits: usdToBase(1),
  });
  const assembled = await assembleTx(x.conn, {
    payer: x.payer,
    instructions: [ix],
    computeUnitLimit: 400_000,
    priorityFeeMicroLamports: 1_000,
  });
  const serialized = Buffer.from(assembled.tx.serialize());
  const sig = bs58.encode(assembled.tx.signatures[0]!);

  // Poll until slotsToCutoff <= offset, then blast.
  let sentAtCutoff = Number.NaN;
  for (;;) {
    const slot = await x.conn.getSlot("processed");
    const cutoff = endSlot - slot;
    if (cutoff <= offset) {
      sentAtCutoff = cutoff;
      await x.conn
        .sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 0 })
        .catch(() => undefined);
      break;
    }
    await sleep(cutoff > 12 ? 800 : 120);
  }
  const outcome = await confirmSignature(x.conn, sig, { timeoutMs: 15_000 });
  let label: string;
  let landedSlot: number | null = null;
  if (outcome.status === "landed") {
    landedSlot = outcome.slot;
    label = `LANDED at end_slot${landedSlot - endSlot >= 0 ? "+" : ""}${landedSlot - endSlot}`;
  } else if (outcome.status === "failed") {
    const tx = await x.conn.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    label = isRoundNotActive(tx?.meta?.err) ? "6005 RoundNotActive" : `failed: ${outcome.error}`;
    landedSlot = tx?.slot ?? null;
  } else {
    label = outcome.status === "missed_round" ? `expired (${outcome.reason})` : outcome.status;
  }
  results.push({ offset, roundId, sentAtCutoff, landedSlot, endSlot, outcome: label, sig });
  x.log(`offset ${offset} → ${label}`);
  await waitRotation(x, roundId, 120_000).catch(() => undefined);
}

const floor = results
  .filter((r) => r.outcome.startsWith("LANDED"))
  .reduce((min, r) => Math.min(min, r.offset), 99);

const md = `## E4 — cutoff boundary (${nowIso()})

One probe per round; a second wallet armed each round first. "sent@" is the
observed slotsToCutoff at send (HTTP slot polling ≈ ±1 slot).

| target offset | round | sent@cutoff | result | evidence |
|---:|---:|---:|---|---|
${results
  .map(
    (r) =>
      `| ${r.offset} | ${r.roundId} | ${r.sentAtCutoff} | ${r.outcome}${r.landedSlot !== null ? ` (slot ${r.landedSlot}, end ${r.endSlot})` : ""} | ${explorer(r.sig)} |`,
  )
  .join("\n")}

**Conclusion (Q4):** smallest offset that landed in this run: **${floor}**. Deploys land when they execute in a slot ≤ end_slot; the boundary is the leader's inclusion latency, not program grace. Empirical FIRE_OFFSET_SLOTS floor on public devnet RPC ≈ ${Math.max(1, floor)} + 1 cushion; keep default 4 remote, revisit at ~2 when colocated.
`;
appendFindings(md);
console.log(md);
