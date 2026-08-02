/**
 * Endpoint smoke test — run after any RPC/gRPC credential or region change
 * (and on the VPS after provisioning):
 *
 *   pnpm exec tsx scripts/smoke-endpoints.ts
 *
 * Verifies: HTTP RPC health + latency, priority-fee API availability,
 * program presence on this cluster, and the Yellowstone gRPC stream
 * (first-slot latency, slot rate, lag vs HTTP). Reads endpoints from .env.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { boardPda, satrushConfigPda } from "../src/adapter/pdas.js";
import { YellowstoneIngest } from "../src/ingest/grpc.js";

const cfg = loadConfig();
const programId = new PublicKey(cfg.PROGRAM_ID);
const ok = (s: string) => console.log(`  ✅ ${s}`);
const bad = (s: string) => console.log(`  ❌ ${s}`);
const info = (s: string) => console.log(`  ·  ${s}`);
let failures = 0;

// ── 1. HTTP RPC ──────────────────────────────────────────────────────────────
console.log(`\n── HTTP RPC: ${new URL(cfg.RPC_HTTP_URL).host} ──`);
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
let httpSlot = 0;
try {
  const t0 = Date.now();
  const version = await conn.getVersion();
  const rtt = Date.now() - t0;
  httpSlot = await conn.getSlot("processed");
  ok(`getVersion ${JSON.stringify(version)} (${rtt}ms RTT)`);
  ok(`slot ${httpSlot} (processed)`);
} catch (err) {
  bad(`RPC unreachable: ${String(err).slice(0, 120)}`);
  failures++;
}
try {
  const fees = await conn.getRecentPrioritizationFees();
  const nonzero = fees.filter((f) => f.prioritizationFee > 0).length;
  ok(`getRecentPrioritizationFees: ${fees.length} samples (${nonzero} nonzero)`);
} catch {
  bad("priority-fee API unavailable — FeeEstimator falls back to EMA/floor");
}

// ── 2. program presence on this cluster ─────────────────────────────────────
console.log(`\n── program ${cfg.PROGRAM_ID.slice(0, 16)}… on this cluster ──`);
try {
  const program = await conn.getAccountInfo(programId);
  if (program?.executable) {
    ok("program deployed + executable");
    const [config, board] = await conn.getMultipleAccountsInfo([
      satrushConfigPda(programId),
      boardPda(programId),
    ]);
    info(`satrush_config ${config ? "present" : "MISSING"}, board ${board ? "present" : "MISSING"}`);
  } else {
    bad(`program NOT deployed on this cluster${program ? " (account exists, not executable)" : ""}`);
    failures++;
  }
} catch (err) {
  bad(`program check failed: ${String(err).slice(0, 120)}`);
  failures++;
}

// ── 3. Yellowstone gRPC ──────────────────────────────────────────────────────
if (!cfg.GRPC_URL) {
  console.log("\n── Yellowstone gRPC: GRPC_URL unset — skipped ──");
} else {
  console.log(`\n── Yellowstone gRPC: ${new URL(cfg.GRPC_URL).host} ──`);
  const source = new YellowstoneIngest({
    endpoint: cfg.GRPC_URL,
    xToken: cfg.GRPC_TOKEN,
    programId,
    watchAccounts: [],
    stalenessMs: cfg.STALENESS_MS,
  });
  const slots: number[] = [];
  const times: number[] = [];
  const started = Date.now();
  source.on("slot", (u) => {
    slots.push(u.slot);
    times.push(Date.now());
  });
  source.on("status", (s) => {
    if (!s.connected && s.detail) info(`status: ${s.detail.slice(0, 100)}`);
  });
  await source.start();
  await new Promise((r) => setTimeout(r, 10_000));
  await source.stop().catch(() => undefined);

  if (slots.length === 0) {
    bad("no slot updates in 10s — check token, region URL, and network path (gRPC needs direct HTTP/2; proxies often block it)");
    failures++;
  } else {
    const firstLatency = times[0]! - started;
    const rate = slots.length / ((times.at(-1)! - times[0]!) / 1000 || 1);
    ok(`first slot in ${firstLatency}ms, ${slots.length} updates in 10s (${rate.toFixed(1)}/s)`);
    if (httpSlot > 0) {
      info(`gRPC head ${slots.at(-1)} vs HTTP slot ${httpSlot} (Δ ${slots.at(-1)! - httpSlot})`);
    }
  }
}

console.log(failures === 0 ? "\nALL ENDPOINT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
