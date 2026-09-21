/**
 * Ops probe: is the Yellowstone/LaserStream feed on this box healthy?
 *
 * Subscribes exactly as the bot does (same client, keepalive, watchdog and
 * replay-on-reconnect) and reports once a minute: slots received, the slot
 * rate, the largest silence between slots, how far the stream trails the
 * HTTP RPC head, and every disconnect with the stream's epitaph. Ends with a
 * verdict. Run it for 10+ minutes while the bot is stopped (or from another
 * box) and send the output to the provider if the stream keeps dying.
 *
 *   pnpm grpc-probe [minutes]      (default 10)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { YellowstoneIngest } from "../src/ingest/grpc.js";

const cfg = loadConfig();
if (!cfg.GRPC_URL) {
  console.error("GRPC_URL is not set — nothing to probe");
  process.exit(2);
}
const minutes = Math.max(1, Number(process.argv[2] ?? 10));
const connection = new Connection(cfg.RPC_HTTP_URL, "processed");
const src = new YellowstoneIngest({
  endpoint: cfg.GRPC_URL,
  xToken: cfg.GRPC_TOKEN,
  programId: new PublicKey(cfg.PROGRAM_ID),
  watchAccounts: [],
  stalenessMs: cfg.STALENESS_MS,
});

const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
let lastSlotAt = 0;
let lastSlot = 0;
let minuteSlots = 0;
let minuteMaxGapMs = 0;
let totalSlots = 0;
let worstGapMs = 0;
let disconnects = 0;
const gaps: number[] = [];

src.on("slot", ({ slot }) => {
  const now = Date.now();
  if (lastSlotAt > 0) {
    const gap = now - lastSlotAt;
    gaps.push(gap);
    if (gap > minuteMaxGapMs) minuteMaxGapMs = gap;
    if (gap > worstGapMs) worstGapMs = gap;
  }
  lastSlotAt = now;
  lastSlot = slot;
  minuteSlots++;
  totalSlots++;
});
src.on("status", (s) => {
  if (!s.connected) disconnects++;
  console.log(`${stamp()} ${s.connected ? "CONNECTED" : "DISCONNECTED"} ${s.detail ?? ""}`);
});

console.log(`${stamp()} probing ${cfg.GRPC_URL.replace(/\/\/([^@/]+@)?/, "//")} for ${minutes} min (STALENESS_MS ${cfg.STALENESS_MS}, watchdog grace ${Math.min(Math.max(cfg.STALENESS_MS * 5, 7_500), 30_000)} ms)`);
await src.start();

const tick = setInterval(() => {
  void (async () => {
    let lag: string = "?";
    try {
      const head = await connection.getSlot("processed");
      lag = String(head - lastSlot);
    } catch {
      /* RPC unreachable this tick */
    }
    console.log(
      `${stamp()} slots ${minuteSlots} (${(minuteSlots / 60).toFixed(2)}/s) · max gap ${minuteMaxGapMs} ms · lag vs RPC head ${lag} · last slot ${lastSlot} · disconnects so far ${disconnects}`,
    );
    minuteSlots = 0;
    minuteMaxGapMs = 0;
  })();
}, 60_000);

setTimeout(async () => {
  clearInterval(tick);
  await src.stop();
  gaps.sort((a, b) => a - b);
  const p99 = gaps[Math.floor(gaps.length * 0.99)] ?? 0;
  const ran = (Date.now() - t0) / 60_000;
  console.log(`\n${stamp()} summary over ${ran.toFixed(1)} min: ${totalSlots} slots (${(totalSlots / (ran * 60)).toFixed(2)}/s), p99 gap ${p99} ms, worst gap ${worstGapMs} ms, disconnects ${disconnects}, reconnects ${src.stats().reconnects}`);
  const healthy = disconnects === 0 && worstGapMs < 5_000;
  console.log(
    healthy
      ? "verdict: healthy — slots ~2.5/s with no silence; a drop seen by the bot outside this window is intermittent, keep the journal"
      : `verdict: UNHEALTHY — ${disconnects} drop(s) / worst silence ${(worstGapMs / 1000).toFixed(1)} s. If the HTTP RPC head kept moving while the stream was silent, the stream (provider or the path to it) is at fault: send this output to the provider with the endpoint region and the timestamps.`,
  );
  process.exit(healthy ? 0 : 1);
}, minutes * 60_000);
