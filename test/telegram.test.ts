import { describe, expect, it } from "vitest";
import type { Update, UserFromGetMe } from "grammy/types";
import { Bankroll } from "../src/strategy/bankroll.js";
import { createTelegramOps, type TelegramDeps } from "../src/ops/telegram.js";
import { usdToBase } from "../src/units.js";

const BOT_INFO = {
  id: 424242,
  is_bot: true,
  first_name: "satrush-test",
  username: "satrush_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

const CHAT_ID = "777001";

function commandUpdate(text: string, chatId: number, updateId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: "private", first_name: "op" },
      from: { id: chatId, is_bot: false, first_name: "op" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
    },
  } as Update;
}

function offlineOps(overrides: Partial<TelegramDeps> = {}) {
  const sent: { chat_id: unknown; text: string }[] = [];
  let paused = false;
  const bankroll = new Bankroll(
    {
      ladder: [usdToBase(1)],
      maxPerRound: usdToBase(5),
      dailyLossCap: usdToBase(20),
      minDeploy: usdToBase(1),
    },
    { realizedLossToday: () => 0n },
  );
  const deps: TelegramDeps = {
    getStatus: () => ({
      mode: "dry",
      roundId: 1810,
      roundState: "Active",
      slotsToCutoff: 31,
      streak: 9,
      todayNet: usdToBase(-3),
      unclaimedUsd: usdToBase(8.1),
      unclaimedShares: 141_384n,
      perRoundCapLeft: usdToBase(5),
      dailyLossCapLeft: usdToBase(17),
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
    getRounds: () => [
      {
        id: 1810,
        winning_tile: 7,
        deployed_usd: "4048000",
        miners_count: 2,
        strike_triggered: 0,
      },
    ],
    getCompetitors: () => [
      {
        round_id: 1810,
        authority: "AbCdEfGhaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaZzZz",
        amount: "5000000",
        total_stake: "4600000",
        is_automation: 1,
        slot: 123,
      },
    ],
    getBoard: () => ({
      roundId: 1810,
      state: "Active",
      slotsToCutoff: 31,
      tileStakesUsd: new Array(21).fill(0).map((_, i) => (i === 0 ? 4.6 : 0)),
      myTiles: [0],
      strikePoolUsd: 12.5,
    }),
    getHealth: () => ({
      ingestFresh: true,
      ingestSlotAgeMs: 120,
      solBalance: 0.5,
      usdcBalance: 4990,
      dbError: null,
    }),
    getDeploys: () => [
      {
        round_id: 1810,
        mask: 0b101, // tiles 0,2
        amount: "1000000",
        status: "landed",
        fired_slot: 1000,
        landed_slot: 1001,
      },
    ],
    ...overrides,
  };
  const ops = createTelegramOps({ token: "test:token", chatId: CHAT_ID, deps, botInfo: BOT_INFO });
  // Offline transformer: capture outgoing API calls, never hit the network.
  ops.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      const p = payload as { chat_id: unknown; text: string };
      sent.push({ chat_id: p.chat_id, text: p.text });
    }
    return { ok: true, result: true } as never;
  });
  return { ops, sent, bankroll, isPaused: () => paused };
}

describe("telegram ops (offline)", () => {
  it("/status replies with round, streak, P&L, unclaimed, caps", async () => {
    const { ops, sent } = offlineOps();
    await ops.bot.handleUpdate(commandUpdate("/status", Number(CHAT_ID), 1));
    expect(sent).toHaveLength(1);
    const text = sent[0]!.text;
    expect(text).toContain("round 1810 · Active · cutoff 31");
    expect(text).toContain("streak 9");
    expect(text).toContain("$-3.00 net");
    expect(text).toContain("141384 shares");
    expect(text).toContain("caps left: $5.00/round · $17.00 daily loss");
  });

  it("/kill flips the real bankroll kill switch", async () => {
    const { ops, sent, bankroll } = offlineOps();
    expect(bankroll.killSwitchEngaged()).toBe(false);
    await ops.bot.handleUpdate(commandUpdate("/kill", Number(CHAT_ID), 2));
    expect(bankroll.killSwitchEngaged()).toBe(true);
    expect(bankroll.killSwitchReason()).toContain("telegram /kill");
    expect(sent[0]!.text).toContain("KILL SWITCH ENGAGED");
    // and authorize() now blocks
    expect(bankroll.authorize(1, usdToBase(1))).toMatchObject({
      ok: false,
      reason: "kill_switch_engaged",
    });
  });

  it("/pause and /resume flip the pause flag", async () => {
    const { ops, isPaused } = offlineOps();
    await ops.bot.handleUpdate(commandUpdate("/pause", Number(CHAT_ID), 3));
    expect(isPaused()).toBe(true);
    await ops.bot.handleUpdate(commandUpdate("/resume", Number(CHAT_ID), 4));
    expect(isPaused()).toBe(false);
  });

  it("/pnl summarizes the day", async () => {
    const { ops, sent } = offlineOps();
    await ops.bot.handleUpdate(commandUpdate("/pnl", Number(CHAT_ID), 5));
    expect(sent[0]!.text).toContain("deployed: $35.00");
    expect(sent[0]!.text).toContain("net: $-26.90");
  });

  it("/board shows the tiles and my positions", async () => {
    const { ops, sent } = offlineOps();
    await ops.bot.handleUpdate(commandUpdate("/board", Number(CHAT_ID), 8));
    expect(sent[0]!.text).toContain("round 1810 Active cutoff=31");
    expect(sent[0]!.text).toContain("my tiles: 0");
    expect(sent[0]!.text).toContain("▸0:4.6");
  });

  it("/rounds and /competitors read history", async () => {
    const { ops, sent } = offlineOps();
    await ops.bot.handleUpdate(commandUpdate("/rounds", Number(CHAT_ID), 9));
    expect(sent[0]!.text).toContain("1810 → tile 7");
    await ops.bot.handleUpdate(commandUpdate("/competitors", Number(CHAT_ID), 10));
    expect(sent[1]!.text).toContain("AbCd…ZzZz");
    expect(sent[1]!.text).toContain("auto");
  });

  it("/health reports ingest and balances", async () => {
    const { ops, sent } = offlineOps();
    await ops.bot.handleUpdate(commandUpdate("/health", Number(CHAT_ID), 11));
    expect(sent[0]!.text).toContain("ingest: fresh");
    expect(sent[0]!.text).toContain("USDC: $4990.00");
  });

  it("/me shows my deploys with tiles and land latency", async () => {
    const { ops, sent } = offlineOps();
    await ops.bot.handleUpdate(commandUpdate("/me", Number(CHAT_ID), 12));
    expect(sent[0]!.text).toContain("1810 [0,2]");
    expect(sent[0]!.text).toContain("✅landed");
    expect(sent[0]!.text).toContain("+1"); // land latency slots
  });

  it("ignores unauthorized chats entirely", async () => {
    const { ops, sent, bankroll } = offlineOps();
    await ops.bot.handleUpdate(commandUpdate("/kill", 999999, 6));
    await ops.bot.handleUpdate(commandUpdate("/status", 999999, 7));
    expect(sent).toHaveLength(0);
    expect(bankroll.killSwitchEngaged()).toBe(false);
  });

  it("alert() pushes to the configured chat", async () => {
    const { ops, sent } = offlineOps();
    await ops.alert("HaltError: tile stake decreased");
    expect(sent[0]!.chat_id).toBe(CHAT_ID);
    expect(sent[0]!.text).toContain("🚨");
    expect(sent[0]!.text).toContain("HaltError");
  });
});
