/**
 * Telegram ops demo in dry mode, offline: injects /status, /pause, /kill
 * updates through grammy's handleUpdate with an API transformer capturing
 * outgoing replies — no token or network needed. Demonstrates that /kill
 * flips the REAL bankroll kill switch and authorize() blocks afterwards.
 *
 * With TELEGRAM_TOKEN + TELEGRAM_CHAT_ID set, the same createTelegramOps()
 * runs live via long polling.
 */
import type { Update, UserFromGetMe } from "grammy/types";
import { createTelegramOps } from "../src/ops/telegram.js";
import { Bankroll } from "../src/strategy/bankroll.js";
import { usdToBase } from "../src/units.js";

const CHAT_ID = "424242";
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "satrush-bot",
  username: "satrush_demo_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

let paused = false;
const bankroll = new Bankroll(
  {
    ladder: [usdToBase(1)],
    maxPerRound: usdToBase(1),
    dailyLossCap: usdToBase(5),
    minDeploy: usdToBase(1),
  },
  { realizedLossToday: () => usdToBase(3) },
);

const ops = createTelegramOps({
  token: "dry:offline-demo",
  chatId: CHAT_ID,
  botInfo: BOT_INFO,
  deps: {
    getStatus: () => ({
      mode: "dry",
      roundId: 1805,
      roundState: "Active",
      slotsToCutoff: 37,
      streak: 9,
      todayNet: usdToBase(-3),
      unclaimedUsd: usdToBase(8.1),
      unclaimedShares: 141_384n,
      perRoundCapLeft: usdToBase(1),
      dailyLossCapLeft: usdToBase(2),
      killSwitch: bankroll.killSwitchEngaged(),
      paused,
    }),
    getPnl: () => ({
      date: "2026-08-01",
      deployed: usdToBase(35),
      returned: usdToBase(8.096),
      net: usdToBase(-26.904),
      feesPaid: usdToBase(2.8),
    }),
    pause: () => (paused = true),
    resume: () => (paused = false),
    kill: (reason) => bankroll.tripKillSwitch(reason),
  },
});

// Capture outgoing API calls instead of hitting Telegram.
ops.api.config.use(async (_prev, method, payload) => {
  if (method === "sendMessage") {
    const p = payload as { text: string };
    console.log(`  ← bot: ${p.text.split("\n").join("\n         ")}`);
  }
  return { ok: true, result: true } as never;
});

let updateId = 0;
async function send(text: string): Promise<void> {
  console.log(`\n  → operator: ${text}`);
  const update = {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(CHAT_ID), type: "private", first_name: "operator" },
      from: { id: Number(CHAT_ID), is_bot: false, first_name: "operator" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  } as Update;
  await ops.bot.handleUpdate(update);
}

console.log("════════ TELEGRAM OPS DEMO (dry mode, offline transport) ════════");
await send("/status");
await send("/pause");
await send("/status");
await send("/resume");
await send("/kill");

console.log("\n  bankroll after /kill:");
console.log(`    killSwitchEngaged = ${bankroll.killSwitchEngaged()}`);
console.log(`    reason            = ${bankroll.killSwitchReason()}`);
const auth = bankroll.authorize(1806, usdToBase(1));
console.log(`    authorize(1806)   = ${JSON.stringify(auth)}`);

console.log("\n  unauthorized chat is ignored:");
await ops.bot.handleUpdate({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 999999, type: "private", first_name: "stranger" },
    from: { id: 999999, is_bot: false, first_name: "stranger" },
    text: "/kill",
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
  },
} as Update);
console.log("    (no reply sent — command dropped)");
console.log("\n════════ DEMO COMPLETE ════════");
