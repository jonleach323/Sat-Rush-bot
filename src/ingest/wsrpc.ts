/**
 * Websocket-RPC fallback ingest source: same event surface as the
 * Yellowstone client (grpc.ts), built on plain Solana RPC subscriptions.
 * Used when GRPC_URL is unconfigured — e.g. local development against the
 * public devnet endpoint. Latency and delivery guarantees are weaker than
 * Yellowstone's; production runs should configure gRPC.
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

export class WsRpcIngest extends IngestSource {
  private connection: Connection | null = null;
  private subscriptionIds: { kind: "slot" | "program" | "account" | "logs"; id: number }[] =
    [];
  private pollTimer: NodeJS.Timeout | null = null;
  private newestPolledSig: string | null = null;
  private readonly seenSigs = new Set<string>();
  private readonly seenSigOrder: string[] = [];

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
    const conn = new Connection(this.opts.httpUrl, "processed");
    this.connection = conn;

    this.subscriptionIds.push({
      kind: "slot",
      id: conn.onSlotChange((info) => {
        this.markSeen("slots");
        this.emit("slot", { slot: info.slot });
      }),
    });

    for (const accountName of ["Board", "Round"] as const) {
      this.subscriptionIds.push({
        kind: "program",
        id: conn.onProgramAccountChange(
          this.opts.programId,
          (keyed, ctx) => {
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
        ),
      });
    }

    for (const pubkey of this.opts.watchAccounts) {
      this.subscriptionIds.push({
        kind: "account",
        id: conn.onAccountChange(
          pubkey,
          (info, ctx) => {
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
        ),
      });
    }

    this.subscriptionIds.push({
      kind: "logs",
      id: conn.onLogs(
        this.opts.programId,
        (logs, ctx) => {
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
      ),
    });

    // logsSubscribe is unreliable on public RPC endpoints (observed never
    // firing on api.devnet.solana.com) — poll signatures as the workhorse
    // path; the subscription above is a low-latency bonus when it works.
    // The first poll only seeds the cursor so history isn't replayed.
    this.pollTimer = setInterval(() => void this.pollSignatures(conn), SIGNATURE_POLL_MS);

    this.emit("status", { connected: true, detail: "ws-rpc fallback" });
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

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const conn = this.connection;
    if (!conn) return;
    await Promise.allSettled(
      this.subscriptionIds.map(({ kind, id }) => {
        switch (kind) {
          case "slot":
            return conn.removeSlotChangeListener(id);
          case "program":
            return conn.removeProgramAccountChangeListener(id);
          case "account":
            return conn.removeAccountChangeListener(id);
          case "logs":
            return conn.removeOnLogsListener(id);
        }
      }),
    );
    this.subscriptionIds = [];
    this.connection = null;
    this.emit("status", { connected: false, detail: "stopped" });
  }
}
