/**
 * Websocket-RPC fallback ingest source: same event surface as the
 * Yellowstone client (grpc.ts), built on plain Solana RPC subscriptions.
 * Used when GRPC_URL is unconfigured — e.g. local development against the
 * public devnet endpoint. Latency and delivery guarantees are weaker than
 * Yellowstone's; production runs should configure gRPC.
 *
 * Self-healing: web3.js does not reliably re-register subscriptions after
 * a dropped websocket (verified against devnet), so a watchdog rebuilds
 * the whole Connection when the slot stream goes silent.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { accountDiscriminator } from "../adapter/idl.js";
import { IngestSource } from "./types.js";

export interface WsRpcIngestOptions {
  httpUrl: string;
  programId: PublicKey;
  /** Extra accounts to watch verbatim: this wallet's Miner PDA, SatsVault. */
  watchAccounts: PublicKey[];
  stalenessMs: number;
}

const SIGNATURE_POLL_MS = 2500;
const MAX_SEEN_SIGNATURES = 512;
const WATCHDOG_INTERVAL_MS = 2000;

export class WsRpcIngest extends IngestSource {
  private connection: Connection | null = null;
  /**
   * Bumped on every (re)subscribe. Callbacks from an abandoned connection
   * check it and go silent — we never call remove*Listener on a dead
   * socket, because web3's subscription manager retries unsubscribe in a
   * tight endless loop when the ws is closed (observed: millions of
   * `slotUnsubscribe error` lines starving the event loop).
   */
  private generation = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private newestPolledSig: string | null = null;
  private readonly seenSigs = new Set<string>();
  private readonly seenSigOrder: string[] = [];
  private running = false;
  private resubscribing = false;
  private startedAtMs = 0;

  constructor(private readonly opts: WsRpcIngestOptions) {
    super(opts.stalenessMs);
  }

  /** True the first time a signature is seen (dedupe across logs + polling). */
  private firstSighting(signature: string): boolean {
    if (this.seenSigs.has(signature)) return false;
    this.seenSigs.add(signature);
    this.seenSigOrder.push(signature);
    while (this.seenSigOrder.length > MAX_SEEN_SIGNATURES) {
      const evicted = this.seenSigOrder.shift();
      if (evicted) this.seenSigs.delete(evicted);
    }
    return true;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startedAtMs = Date.now();
    this.subscribe();

    // logsSubscribe is unreliable on public RPC endpoints (observed never
    // firing on api.devnet.solana.com) — poll signatures as the workhorse
    // path; the ws subscription is a low-latency bonus when it works.
    // The first poll only seeds the cursor so history isn't replayed.
    this.pollTimer = setInterval(() => {
      const conn = this.connection;
      if (conn) void this.pollSignatures(conn);
    }, SIGNATURE_POLL_MS);

    // Self-heal: rebuild the Connection when the slot stream dies.
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);

    this.emit("status", { connected: true, detail: "ws-rpc fallback" });
  }

  /** Open a fresh Connection and register every subscription on it. */
  private subscribe(): void {
    const gen = ++this.generation;
    const live = () => gen === this.generation;
    const conn = new Connection(this.opts.httpUrl, "processed");
    this.connection = conn;

    conn.onSlotChange((info) => {
      if (!live()) return;
      this.markSeen("slots");
      this.emit("slot", { slot: info.slot });
    });

    for (const accountName of ["Board", "Round"] as const) {
      conn.onProgramAccountChange(
        this.opts.programId,
        (keyed, ctx) => {
          if (!live()) return;
          this.markSeen("accounts");
          this.emit("account", {
            pubkey: keyed.accountId,
            owner: keyed.accountInfo.owner,
            data: keyed.accountInfo.data,
            slot: ctx.slot,
            stream: "accounts",
          });
        },
        "processed",
        [
          {
            memcmp: {
              offset: 0,
              bytes: bs58.encode(accountDiscriminator(accountName)),
            },
          },
        ],
      );
    }

    for (const pubkey of this.opts.watchAccounts) {
      conn.onAccountChange(
        pubkey,
        (info, ctx) => {
          if (!live()) return;
          this.markSeen("wallet");
          this.emit("account", {
            pubkey,
            owner: info.owner,
            data: info.data,
            slot: ctx.slot,
            stream: "wallet",
          });
        },
        "processed",
      );
    }

    conn.onLogs(
      this.opts.programId,
      (logs, ctx) => {
        if (!live()) return;
        if (!this.firstSighting(logs.signature)) return;
        this.markSeen("transactions");
        void this.emitWithInnerIx(conn, {
          signature: logs.signature,
          slot: ctx.slot,
          logs: logs.logs,
          failed: logs.err !== null,
        });
      },
      "processed",
    );
  }

  /** Rebuild everything when the slot stream has been silent too long. */
  private watchdog(): void {
    if (!this.running || this.resubscribing) return;
    const quietFor = this.lastUpdateAgeMs("slots");
    const grace = Math.max(this.stalenessMs * 5, 7_500);
    // lastUpdateAgeMs is Infinity before the first slot — give startup grace.
    if (quietFor === Number.POSITIVE_INFINITY && Date.now() - this.startedAtMs < grace) {
      return;
    }
    if (quietFor <= grace) return;

    this.resubscribing = true;
    this.emit("status", {
      connected: false,
      detail: `slot stream silent ${Math.round(quietFor)}ms — rebuilding connection`,
    });
    this.teardownConnection();
    try {
      this.subscribe();
      this.markSeen("slots"); // reset the clock so we don't thrash-rebuild
      this.emit("status", { connected: true, detail: "resubscribed" });
    } finally {
      this.resubscribing = false;
    }
  }

  /**
   * Abandon the connection: bump the generation (its callbacks go silent)
   * and close the socket. Deliberately NO remove*Listener calls — see the
   * generation-counter comment.
   */
  private teardownConnection(): void {
    const conn = this.connection;
    this.connection = null;
    this.generation++;
    if (!conn) return;
    const ws = (conn as unknown as { _rpcWebSocket?: { close(): void } })._rpcWebSocket;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  private async pollSignatures(conn: Connection): Promise<void> {
    try {
      const seeding = this.newestPolledSig === null;
      const sigs = await conn.getSignaturesForAddress(
        this.opts.programId,
        { limit: 25, ...(this.newestPolledSig ? { until: this.newestPolledSig } : {}) },
        "confirmed",
      );
      if (sigs.length === 0) return;
      this.newestPolledSig = sigs[0]!.signature;
      if (seeding) return;
      for (const info of [...sigs].reverse()) {
        if (!this.firstSighting(info.signature)) continue;
        this.markSeen("transactions");
        await this.emitWithInnerIx(conn, {
          signature: info.signature,
          slot: info.slot,
          logs: [],
          failed: info.err !== null,
        });
      }
    } catch {
      /* transient RPC failure — next tick retries */
    }
  }

  /**
   * The program emits events via `emit_cpi!`, whose payloads live in inner
   * instructions — not in logs. Unlike Yellowstone, log subscriptions can't
   * carry them, so fetch the transaction (needs confirmed commitment; retry
   * briefly while the processed→confirmed gap closes) before emitting.
   */
  private async emitWithInnerIx(
    conn: Connection,
    update: { signature: string; slot: number; logs: string[]; failed: boolean },
  ): Promise<void> {
    let innerIxDatas: Uint8Array[] | undefined;
    let logs = update.logs;
    for (let attempt = 0; attempt < 6 && !innerIxDatas; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 400 : 700));
      try {
        const tx = await conn.getTransaction(update.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (tx?.meta) {
          innerIxDatas = (tx.meta.innerInstructions ?? []).flatMap((group) =>
            group.instructions.map((ix) => Uint8Array.from(bs58.decode(ix.data))),
          );
          if (logs.length === 0) logs = tx.meta.logMessages ?? [];
        }
      } catch {
        /* transient RPC failure — retry */
      }
    }
    this.emit("txLogs", { ...update, logs, innerIxDatas });
  }

  /**
   * Chaos hook: force-close the underlying websocket mid-run. The watchdog
   * detects the silent slot stream and rebuilds the connection.
   */
  simulateDisconnect(): void {
    const ws = (
      this.connection as unknown as { _rpcWebSocket?: { close(): void } } | null
    )?._rpcWebSocket;
    ws?.close();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.teardownConnection();
    this.emit("status", { connected: false, detail: "stopped" });
  }
}
