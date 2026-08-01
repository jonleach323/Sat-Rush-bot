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

export class WsRpcIngest extends IngestSource {
  private connection: Connection | null = null;
  private subscriptionIds: { kind: "slot" | "program" | "account" | "logs"; id: number }[] =
    [];

  constructor(private readonly opts: WsRpcIngestOptions) {
    super(opts.stalenessMs);
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

    this.emit("status", { connected: true, detail: "ws-rpc fallback" });
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
        }
      } catch {
        /* transient RPC failure — retry */
      }
    }
    this.emit("txLogs", { ...update, innerIxDatas });
  }

  async stop(): Promise<void> {
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
