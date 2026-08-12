/**
 * Read-only monitoring HTTP API. STRICTLY read-only — there is no endpoint
 * that can deploy, change caps, or stop the bot (a leaked token must not be
 * able to act; /kill lives on Telegram + the KILL file). Disabled entirely
 * unless API_TOKEN is set. Binds localhost by default; expose remotely via
 * a tunnel (Cloudflare Tunnel / Tailscale), not by opening 0.0.0.0.
 *
 * GET /health            — liveness only, NO auth (for uptime monitors)
 * GET /                  — the dashboard (HTML; page then auths its own calls)
 * GET /api/status        — auth
 * GET /api/pnl           — auth
 * GET /api/health        — auth (balances)
 * GET /api/rounds?limit  — auth
 * GET /api/deploys?limit — auth
 * GET /api/competitors?limit — auth
 * GET /api/vault          — auth
 *
 * Auth: `Authorization: Bearer <token>` or `?token=<token>`.
 */
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { DASHBOARD_HTML } from "./dashboard.js";
import type { MonitorData } from "./monitor.js";

export interface MonitorApiOptions {
  token: string;
  host: string;
  port: number;
  data: MonitorData;
  mode: string;
  startedAtMs: number;
  logger?: Logger | undefined;
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class MonitorApi {
  private server: Server | null = null;

  constructor(private readonly opts: MonitorApiOptions) {
    if (!opts.token) throw new Error("MonitorApi requires a non-empty token");
  }

  async start(): Promise<void> {
    const { data, token, mode } = this.opts;
    this.server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const send = (code: number, body: unknown, isHtml = false) => {
          res.writeHead(code, {
            "content-type": isHtml ? "text/html; charset=utf-8" : "application/json",
            "cache-control": "no-store",
          });
          res.end(isHtml ? (body as string) : JSON.stringify(body));
        };

        if (req.method !== "GET") return send(405, { error: "read-only: GET only" });

        // liveness — no auth
        if (url.pathname === "/health") {
          return send(200, {
            ok: true,
            mode,
            uptimeS: Math.round((Date.now() - this.opts.startedAtMs) / 1000),
          });
        }
        // dashboard page — no auth to load; its fetches carry the token
        if (url.pathname === "/" || url.pathname === "/dashboard") {
          return send(200, DASHBOARD_HTML, true);
        }

        if (url.pathname.startsWith("/api/")) {
          const header = req.headers["authorization"];
          const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
          const provided = bearer ?? url.searchParams.get("token");
          if (!tokenMatches(provided, token)) return send(401, { error: "unauthorized" });

          const limit = Number(url.searchParams.get("limit") ?? 25);
          try {
            switch (url.pathname) {
              case "/api/status":
                return send(200, data.status());
              case "/api/pnl":
                return send(200, data.pnlDaily(limit));
              case "/api/health":
                return send(200, await data.health());
              case "/api/rounds":
                return send(200, data.recentRounds(limit));
              case "/api/deploys":
                return send(200, data.recentDeploys(limit));
              case "/api/competitors":
                return send(200, data.recentCompetitors(limit));
              case "/api/vault":
                return send(200, data.vault());
              case "/api/intel":
                return send(200, data.intel(Number(url.searchParams.get("window") ?? 500)));
              default:
                return send(404, { error: "not found" });
            }
          } catch (err) {
            this.opts.logger?.error({ err: String(err) }, "api handler error");
            return send(500, { error: "internal" });
          }
        }
        return send(404, { error: "not found" });
      })();
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, this.opts.host, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    this.opts.logger?.info(
      { bind: `${this.opts.host}:${this.opts.port}` },
      "monitoring API listening (read-only)",
    );
  }

  /** The actual bound port (useful when port 0 was requested in tests). */
  address(): { port: number } | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? { port: addr.port } : null;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
