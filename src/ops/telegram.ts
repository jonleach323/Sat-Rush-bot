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
  // optional enrichments (shown if present)
  boardTotalUsd?: number | undefined;
  strikePoolUsd?: number | undefined;
  myStakeUsd?: number | undefined;
  ingestFresh?: boolean | undefined;
  // V2 (shown if present)
  gameVersion?: string | undefined;
  /** Net today with the day's won shares marked — what the daily cap runs on. */
  markedNet?: bigint | undefined;
  unclaimedSharesUsd?: number | undefined;
  unclaimedTokenShares?: bigint | undefined;
  unclaimedTokenUsd?: number | undefined;
  /** USD of RUSH per USD of volume the selector credits; null when the feed is down. */
  tokenYield?: number | null | undefined;
  rushUsd?: number | null | undefined;
  satsVaultApr?: number | null | undefined;
  carryCredited?: { sats: number; token: number } | null | undefined;
  walletCount?: number | undefined;
}

export interface WalletRow {
  pubkey: string;
  streak: number;
  hashrate: number;
  tickets: number;
  usdc: number;
  sol: number;
  disabled: string | null;
}

export interface DeployRow {
  round_id: number;
  mask: number;
  amount: string;
  status: string;
  fired_slot: number | null;
  landed_slot: number | null;
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
  getDeploys?(limit: number): DeployRow[] | Promise<DeployRow[]>;
  getVault?(): VaultReport | Promise<VaultReport>;
  getWallets?(): WalletRow[] | Promise<WalletRow[]>;
  getFleet?(): FleetReport | Promise<FleetReport>;
}

/** The fleet treasury's view: balances, per-tile runway, pending and last transfers. */
export interface FleetReport {
  size: number;
  tileMode: boolean;
  treasuryEnabled: boolean;
  primary: string;
  wallets: (WalletRow & { tile: number | null; runwayRounds: number | null })[];
  pending: { from: string; to: string; asset: "usdc" | "sol"; amount: number; reason: "top_up" | "sweep" }[];
  /** Per-wallet USDC float the treasury is holding each wallet to (derived from the observed peak leg). */
  targetUsd: number | null;
  shortfallUsd: number;
  shortfallSol: number;
  minRunwayRounds: number | null;
  last: { at: number; transfers: number; executed: number; dry: boolean } | null;
}

export interface VaultReport {
  enabled: boolean;
  hashrate: number;
  unclaimedHashrate: number;
  epoch: { ticketsBought: number; iterationsPlayed: number; iterationsClaimed: number };
  oneBtc: { ticketsBought: number; iterationsPlayed: number; iterationsClaimed: number };
  recent: Record<string, unknown>[];
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

const tilesOfMask = (mask: number): number[] => {
  const t: number[] = [];
  for (let i = 0; i < 21; i++) if (mask & (1 << i)) t.push(i);
  return t;
};

export function formatStatus(s: StatusReport): string {
  const flags = `${s.paused ? " ⏸PAUSED" : ""}${s.killSwitch ? " ⛔KILL" : ""}`;
  const ingest = s.ingestFresh === undefined ? "" : s.ingestFresh ? " · ingest live" : " · ⚠INGEST STALE";
  const game = s.gameVersion ? ` · ${s.gameVersion.toUpperCase()}` : "";
  const fleet = s.walletCount && s.walletCount > 1 ? ` · ${s.walletCount} wallets` : "";
  const lines = [
    `⛏ SAT RUSH — ${s.mode.toUpperCase()}${game}${fleet}${flags}${ingest}`,
    `round ${s.roundId ?? "?"} · ${s.roundState ?? "—"} · cutoff ${s.slotsToCutoff ?? "—"}`,
    s.markedNet !== undefined
      ? `today: ${usd(s.markedNet)} net (shares marked; USD-only ${usd(s.todayNet)}) · streak ${s.streak ?? "?"}`
      : `today: ${usd(s.todayNet)} net · streak ${s.streak ?? "?"}`,
  ];
  if (s.boardTotalUsd !== undefined) {
    lines.push(
      `board: ${usdn(s.boardTotalUsd)}${s.myStakeUsd ? ` · my stake ${usdn(s.myStakeUsd)}` : ""}` +
        (s.strikePoolUsd !== undefined ? ` · strike ${usdn(s.strikePoolUsd)}` : ""),
    );
  }
  if (s.unclaimedSharesUsd !== undefined) {
    lines.push(
      `unclaimed: ${usd(s.unclaimedUsd)} USDC · ${s.unclaimedShares} BTC shares ≈ ${usdn(s.unclaimedSharesUsd)}` +
        (s.unclaimedTokenShares !== undefined
          ? ` · ${s.unclaimedTokenShares} RUSH shares ≈ ${usdn(s.unclaimedTokenUsd ?? 0)}`
          : ""),
    );
  } else {
    lines.push(`unclaimed: ${usd(s.unclaimedUsd)} + ${s.unclaimedShares} shares`);
  }
  if (s.tokenYield !== undefined) {
    const y = s.tokenYield === null ? "feed down → 0" : `${(100 * s.tokenYield).toFixed(2)}% of volume`;
    const px = s.rushUsd === null || s.rushUsd === undefined ? "" : ` · RUSH ${usdn(s.rushUsd)}`;
    const apr = s.satsVaultApr === null || s.satsVaultApr === undefined ? "" : ` · sats vault apr ${(100 * s.satsVaultApr).toFixed(0)}%`;
    const carry = s.carryCredited
      ? ` · carry credited ${(100 * s.carryCredited.sats).toFixed(1)}%/${(100 * s.carryCredited.token).toFixed(1)}%`
      : " · carry not credited";
    lines.push(`token yield: ${y}${px}${apr}${carry}`);
  }
  lines.push(`caps left: ${usd(s.perRoundCapLeft)}/round · ${usd(s.dailyLossCapLeft)} daily loss`);
  return lines.join("\n");
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

  bot.command("me", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    if (!opts.deps.getDeploys) return void ctx.reply("deploy history unavailable");
    const rows = await opts.deps.getDeploys(10);
    if (rows.length === 0) return void ctx.reply("no deploys yet");
    await ctx.reply(
      ["my deploys (round tiles amount status land):"]
        .concat(
          rows.map((d) => {
            const land =
              d.landed_slot && d.fired_slot ? `+${d.landed_slot - d.fired_slot}` : "—";
            const mark = d.status === "landed" ? "✅" : d.status === "dry" ? "○" : "✗";
            return `${d.round_id} [${tilesOfMask(d.mask).join(",")}] ${usdn(Number(d.amount) / 1e6)} ${mark}${d.status} ${land}`;
          }),
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

  bot.command("vault", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    if (!opts.deps.getVault) return void ctx.reply("vault data unavailable");
    const v = await opts.deps.getVault();
    const lines = [
      `⛏ vault: ${v.enabled ? "ON" : "OFF"}`,
      `hashrate: ${v.hashrate} (unclaimed ${v.unclaimedHashrate})`,
      `epoch: ${v.epoch.ticketsBought} tickets / ${v.epoch.iterationsPlayed} draws / ${v.epoch.iterationsClaimed} claimed`,
      `1-BTC: ${v.oneBtc.ticketsBought} tickets / ${v.oneBtc.iterationsPlayed} draws / ${v.oneBtc.iterationsClaimed} claimed`,
    ];
    if (v.recent.length > 0) {
      lines.push("recent:");
      for (const r of v.recent.slice(0, 8)) {
        lines.push(
          `  ${r.kind} it${r.iteration_id} ×${r.tickets}${r.claimed ? " ✓" : ""}`,
        );
      }
    }
    await ctx.reply(lines.join("\n"));
  });

  bot.command("wallets", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    if (!opts.deps.getWallets) return void ctx.reply("wallet data unavailable");
    const rows = await opts.deps.getWallets();
    if (rows.length === 0) return void ctx.reply("no wallets");
    const totalUsdc = rows.reduce((a, w) => a + w.usdc, 0);
    await ctx.reply(
      [
        `👛 ${rows.length} wallet${rows.length > 1 ? "s" : ""} · ${usdn(totalUsdc)} USDC total (caps are aggregate)`,
        ...rows.map(
          (w, i) =>
            `${i === 0 ? "★" : " "} ${short(w.pubkey)} ${usdn(w.usdc)} · ${w.sol.toFixed(3)} SOL · streak ${w.streak} · hr ${w.hashrate} · tix ${w.tickets}` +
            (w.disabled ? ` · ⚠ ${w.disabled}` : ""),
        ),
      ].join("\n"),
    );
  });

  bot.command("fleet", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    if (!opts.deps.getFleet) return void ctx.reply("fleet data unavailable");
    const f = await opts.deps.getFleet();
    if (f.size <= 1) return void ctx.reply("single wallet — no fleet (set FLEET_SIZE and run pnpm fleet:init)");
    const lines = [
      `🏦 fleet of ${f.size} · tile mode ${f.tileMode ? "on" : "off"} · treasury ${f.treasuryEnabled ? "on" : "off"} · deposit to ${short(f.primary)}`,
      `float target $${(f.targetUsd ?? 0).toFixed(0)}/wallet (from the peak leg) · thinnest wallet: ${f.minRunwayRounds ?? "?"} rounds of runway` +
        (f.shortfallUsd > 0 || f.shortfallSol > 0 ? ` · ⚠ NEEDS ${f.shortfallUsd > 0 ? usdn(f.shortfallUsd) + " USDC " : ""}${f.shortfallSol > 0 ? f.shortfallSol.toFixed(3) + " SOL" : ""}` : " · funded"),
      ...f.wallets.map((w, i) => `${i === 0 ? "★" : " "} t${String(w.tile ?? "-").padStart(2)} ${short(w.pubkey)} ${usdn(w.usdc)} · ${w.sol.toFixed(3)} SOL · ${w.runwayRounds ?? "?"} rds · streak ${w.streak}` + (w.disabled ? ` ⚠ ${w.disabled}` : "")),
      f.pending.length ? `pending: ${f.pending.map((t) => `${t.reason === "top_up" ? "→" : "←"} ${short(t.to)} ${t.asset === "usdc" ? usdn(t.amount) : t.amount.toFixed(3) + " SOL"}`).join(", ")}` : "pending: none",
      f.last ? `last cycle ${new Date(f.last.at).toISOString().slice(11, 19)}Z: ${f.last.executed}/${f.last.transfers} sent${f.last.dry ? " (dry)" : ""}` : "no cycle yet",
    ];
    await ctx.reply(lines.join("\n"));
  });

  bot.command("help", async (ctx) => {
    if (!authorized(ctx.chat?.id)) return;
    await ctx.reply(
      [
        "⛏ SAT RUSH commands (V2)",
        "view: /status /board /me /pnl /rounds /competitors /vault /wallets /fleet /health",
        "control: /pause /resume /kill",
        "/status shows the marked net (BTC+RUSH shares valued), the token yield and the vault carry",
      ].join("\n"),
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
