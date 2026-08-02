/**
 * Telegram ops (grammy): /status /pause /resume /kill /pnl + push alerts.
 * Only the configured TELEGRAM_CHAT_ID is honored; anything else is ignored
 * silently. All game-side effects go through injected deps so the bot works
 * identically in dry mode and offline tests (handleUpdate + api transformer).
 */
import { Bot, type Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Logger } from "pino";
import { baseToUsd } from "../units.js";

export interface StatusReport {
  mode: string;
  roundId: number | null;
  roundState: string | null;
  slotsToCutoff: number | null;
  streak: number | null;
  todayNet: bigint;
  unclaimedUsd: bigint;
  unclaimedShares: bigint;
  perRoundCapLeft: bigint;
  dailyLossCapLeft: bigint;
  killSwitch: boolean;
  paused: boolean;
}

export interface PnlSummary {
  date: string;
  deployed: bigint;
  returned: bigint;
  net: bigint;
  feesPaid: bigint;
}

export interface TelegramDeps {
  getStatus(): StatusReport | Promise<StatusReport>;
  getPnl(): PnlSummary | Promise<PnlSummary>;
  pause(): void;
  resume(): void;
  kill(reason: string): void;
}

export interface TelegramOpsOptions {
  token: string;
  chatId: string;
  deps: TelegramDeps;
  logger?: Logger | undefined;
  /** Provide to skip the getMe network call (offline/dry testing). */
  botInfo?: UserFromGetMe | undefined;
}

export interface TelegramOps {
  bot: Bot;
  api: Api;
  /** Push an alert to the configured chat (errors swallowed + logged). */
  alert(text: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

const usd = (v: bigint) => `$${baseToUsd(v).toFixed(2)}`;

export function formatStatus(s: StatusReport): string {
  return [
    `mode: ${s.mode}${s.paused ? " (PAUSED)" : ""}${s.killSwitch ? " ⛔ KILL SWITCH" : ""}`,
    `round: ${s.roundId ?? "?"} ${s.roundState ?? ""} cutoff=${s.slotsToCutoff ?? "—"}`,
    `streak: ${s.streak ?? "?"}`,
    `today: ${usd(s.todayNet)} net`,
    `unclaimed: ${usd(s.unclaimedUsd)} + ${s.unclaimedShares} shares`,
    `caps left: ${usd(s.perRoundCapLeft)}/round, ${usd(s.dailyLossCapLeft)} daily loss`,
  ].join("\n");
}

export function createTelegramOps(opts: TelegramOpsOptions): TelegramOps {
  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  const log = opts.logger;

  const authorized = (chatId: number | undefined): boolean =>
    chatId !== undefined && chatId.toString() === opts.chatId;

  bot.command("status", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    await ctx.reply(formatStatus(await opts.deps.getStatus()));
  });

  bot.command("pnl", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    const p = await opts.deps.getPnl();
    await ctx.reply(
      [
        `pnl ${p.date}`,
        `deployed: ${usd(p.deployed)}`,
        `returned: ${usd(p.returned)}`,
        `net: ${usd(p.net)}`,
        `fees (deploy legs): ${usd(p.feesPaid)}`,
      ].join("\n"),
    );
  });

  bot.command("pause", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    opts.deps.pause();
    await ctx.reply("⏸ paused — no new deployments until /resume");
  });

  bot.command("resume", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    opts.deps.resume();
    await ctx.reply("▶️ resumed");
  });

  bot.command("kill", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    opts.deps.kill("telegram /kill");
    await ctx.reply("⛔ KILL SWITCH ENGAGED — all sending halted (restart to clear)");
  });

  const alert = async (text: string): Promise<void> => {
    try {
      await bot.api.sendMessage(opts.chatId, `🚨 ${text}`);
    } catch (err) {
      log?.error({ err: String(err) }, "telegram alert failed");
    }
  };

  return {
    bot,
    api: bot.api,
    alert,
    start: () => {
      // long-polling in the background; errors logged, not fatal
      void bot.start({ onStart: () => log?.info("telegram bot started") }).catch((err) => {
        log?.error({ err: String(err) }, "telegram bot stopped with error");
      });
    },
    stop: () => bot.stop(),
  };
}
