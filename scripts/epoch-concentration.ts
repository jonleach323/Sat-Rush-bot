/**
 * The exact ticket distribution of a COMPLETED epoch iteration.
 *
 * Concentration is the softest input in every dedup estimate here, and it is
 * the one the whole split-incentive argument turns on: rival blocks leaving the
 * pool as they are drawn is what pays small holders above pro-rata, and the
 * size of that effect is set entirely by how top-heavy the field is. Until now
 * it was an assumption — the LIVE iteration's partial shape, scaled to a
 * completed iteration's total, because settled entries are rent-reclaimed.
 *
 * EpochTicketsBought removes the assumption. Every purchase carries its
 * authority and amount, so replaying an iteration's buys reconstructs the exact
 * final distribution of a draw that has already happened.
 *
 *   pnpm epoch-concentration [iteration]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";
import { decodeAccount, type EpochVault, type SatrushConfig } from "../src/adapter/idl.js";
import { parseCpiEventData } from "../src/ingest/events.js";
import { epochVaultPda, satrushConfigPda } from "../src/adapter/pdas.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const num = (v: unknown): number => Number((v as { toString(): string }).toString());

const vault = epochVaultPda(pid);
const evInfo = await conn.getAccountInfo(vault, "confirmed");
const confInfo = await conn.getAccountInfo(satrushConfigPda(pid), "confirmed");
if (!evInfo || !confInfo) throw new Error("vault or config unavailable");
const ev = decodeAccount<EpochVault>("EpochVault", evInfo.data);
const conf = decodeAccount<SatrushConfig>("SatrushConfig", confInfo.data);
const iterDur = num(conf.epoch_vault_iteration_duration);
const liveStart = num(ev.last_trigger_slot);

const TARGET = Number(process.argv[2] ?? ev.iteration_id - 1);
const back = ev.iteration_id - TARGET;
const startSlot = liveStart - back * iterDur;
const endSlot = startSlot + iterDur;
console.log(`iteration ${TARGET}: slots ${startSlot.toLocaleString()} → ${endSlot.toLocaleString()}`);

// Collect every signature inside the window.
const sigs: string[] = [];
let before: string | undefined;
let pages = 0;
while (pages < 80) {
  const page = await conn.getSignaturesForAddress(
    vault,
    { limit: 1000, ...(before ? { before } : {}) },
    "confirmed",
  );
  if (page.length === 0) break;
  pages++;
  for (const s of page) {
    if (s.err) continue;
    if (s.slot >= startSlot && s.slot <= endSlot) sigs.push(s.signature);
  }
  const last = page[page.length - 1];
  if (!last) break;
  before = last.signature;
  if (last.slot < startSlot) break;
  if (page.length < 1000) break;
}
console.log(`${sigs.length.toLocaleString()} signatures in window; decoding…`);

const byWallet = new Map<string, number>();
let decoded = 0;
for (let i = 0; i < sigs.length; i += 50) {
  const txs = await conn.getTransactions(sigs.slice(i, i + 50), {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  for (const tx of txs) {
    if (!tx) continue;
    decoded++;
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
    });
    for (const inner of tx.meta?.innerInstructions ?? []) {
      for (const ix of inner.instructions) {
        if (keys.get(ix.programIdIndex)?.toBase58() !== pid.toBase58()) continue;
        let data: Uint8Array;
        try {
          data = bs58.decode(ix.data);
        } catch {
          continue;
        }
        const e = parseCpiEventData(data, tx.slot, "");
        if (!e || e.name !== "EpochTicketsBought") continue;
        const d = e.data as Record<string, unknown>;
        if (Number(d["iteration_id"] ?? -1) !== TARGET) continue;
        const who = String(d["authority"] ?? "");
        byWallet.set(who, (byWallet.get(who) ?? 0) + num(d["tickets_amount"] ?? 0));
      }
    }
  }
  if (i % 1000 === 0 && i > 0) process.stdout.write(`\r  ${i}/${sigs.length}…`);
}
console.log(`\rdecoded ${decoded.toLocaleString()} transactions        `);

const blocks = [...byWallet.values()].sort((a, b) => b - a);
const total = blocks.reduce((a, b) => a + b, 0);
if (total === 0) {
  console.log("No EpochTicketsBought events found for that iteration.");
} else {
  const share = (n: number) => blocks.slice(0, n).reduce((a, b) => a + b, 0) / total;
  console.log(`\n═══ iteration ${TARGET}: MEASURED distribution ═══`);
  console.log(`  wallets        ${blocks.length}`);
  console.log(`  total tickets  ${total.toLocaleString()}`);
  console.log(`  top 1          ${(100 * share(1)).toFixed(1)}%`);
  console.log(`  top 3          ${(100 * share(3)).toFixed(1)}%`);
  console.log(`  top 5          ${(100 * share(5)).toFixed(1)}%`);
  console.log(`  top 10         ${(100 * share(10)).toFixed(1)}%`);
  const gini = (() => {
    const s = [...blocks].sort((a, b) => a - b);
    let cum = 0;
    for (let i = 0; i < s.length; i++) cum += (2 * (i + 1) - s.length - 1) * (s[i] as number);
    return cum / (s.length * total);
  })();
  console.log(`  gini           ${gini.toFixed(3)}`);
  console.log(`  blocks (top 12): ${blocks.slice(0, 12).map((b) => b.toLocaleString()).join(", ")}`);
  // Persist so the simulators stop guessing at the shape.
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync("data", { recursive: true });
  const path = `data/epoch-iteration-${TARGET}.json`;
  writeFileSync(path, JSON.stringify({ iteration: TARGET, wallets: blocks.length, total, blocks }, null, 2));
  console.log(`\n  wrote ${path} — dedup-effect and sybil-curve prefer it over the scaled live shape.`);
}
