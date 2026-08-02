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

export interface RoundRow {
  id: number;
  winning_tile: number | null;
  deployed_usd: string;
  miners_count: number;
  strike_triggered: number;
}

export interface CompetitorRow {
  round_id: number;
  authority: string;
  amount: string;
  total_stake: string;
  is_automation: number;
  slot: number;
}

export interface BoardReport {
  roundId: number | null;
  state: string | null;
  slotsToCutoff: number | null;
  tileStakesUsd: number[];
  myTiles: number[];
  strikePoolUsd: number;
}

export interface HealthReport {
  ingestFresh: boolean;
  ingestSlotAgeMs: number;
  solBalance: number | null;
  usdcBalance: number | null;
  dbError: string | null;
}

export interface TelegramDeps {
  getStatus(): StatusReport | Promise<StatusReport>;
  getPnl(): PnlSummary | Promise<PnlSummary>;
  pause(): void;
  resume(): void;
  kill(reason: string): void;
  // read-through commands (optional — degrade gracefully if absent)
  getRounds?(limit: number): RoundRow[] | Promise<RoundRow[]>;
  getCompetitors?(limit: number): CompetitorRow[] | Promise<CompetitorRow[]>;
  getBoard?(): BoardReport | Promise<BoardReport>;
  getHealth?(): HealthReport | Promise<HealthReport>;
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
const usdn = (n: number) => `$${n.toFixed(2)}`;
const short = (s: string) => (s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

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

  bot.command("board", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    if (!opts.deps.getBoard) return void ctx.reply("board data unavailable");
    const b = await opts.deps.getBoard();
    const mine = new Set(b.myTiles);
    const grid = b.tileStakesUsd
      .map((v, i) => `${mine.has(i) ? "▸" : " "}${i}:${v.toFixed(1)}`)
      .join("  ");
    await ctx.reply(
      [
        `round ${b.roundId ?? "?"} ${b.state ?? ""} cutoff=${b.slotsToCutoff ?? "—"}`,
        `strike pool: ${usdn(b.strikePoolUsd)}`,
        `my tiles: ${b.myTiles.length ? b.myTiles.join(",") : "none"}`,
        "tiles (▸=mine):",
        grid,
      ].join("\n"),
    );
  });

  bot.command("rounds", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    if (!opts.deps.getRounds) return void ctx.reply("round history unavailable");
    const rows = await opts.deps.getRounds(10);
    if (rows.length === 0) return void ctx.reply("no rounds recorded yet");
    await ctx.reply(
      ["last rounds (round win pot miners):"]
        .concat(
          rows.map(
            (r) =>
              `${r.id} → tile ${r.winning_tile ?? "—"}  ${usdn(Number(r.deployed_usd) / 1e6)}  ${r.miners_count}p${r.strike_triggered ? " ⚡" : ""}`,
          ),
        )
        .join("\n"),
    );
  });

  bot.command("competitors", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    if (!opts.deps.getCompetitors) return void ctx.reply("competitor data unavailable");
    const rows = await opts.deps.getCompetitors(10);
    if (rows.length === 0) return void ctx.reply("no competitor deploys recorded yet");
    await ctx.reply(
      ["recent rivals (round wallet gross auto):"]
        .concat(
          rows.map(
            (c) =>
              `${c.round_id} ${short(c.authority)} ${usdn(Number(c.amount) / 1e6)}${c.is_automation ? " auto" : ""}`,
          ),
        )
        .join("\n"),
    );
  });

  bot.command("health", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    if (!opts.deps.getHealth) return void ctx.reply("health data unavailable");
    const h = await opts.deps.getHealth();
    await ctx.reply(
      [
        `ingest: ${h.ingestFresh ? "fresh" : `STALE ${h.ingestSlotAgeMs}ms`}`,
        `SOL: ${h.solBalance === null ? "?" : h.solBalance.toFixed(4)}`,
        `USDC: ${h.usdcBalance === null ? "?" : usdn(h.usdcBalance)}`,
        `db: ${h.dbError ? `ERROR ${h.dbError}` : "ok"}`,
      ].join("\n"),
    );
  });

  bot.command("help", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    await ctx.reply(
      "/status /pnl /board /rounds /competitors /health · /pause /resume /kill",
    );
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
