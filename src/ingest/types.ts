/**
 * Shared ingest-source contract. Both the Yellowstone gRPC client (grpc.ts)
 * and the websocket-RPC fallback emit the same events, so the orchestrator
 * and scripts are source-agnostic.
 */
import { EventEmitter } from "node:events";
import type { PublicKey } from "@solana/web3.js";

export type StreamName = "slots" | "accounts" | "wallet" | "transactions";

export interface SlotUpdate {
  slot: number;
}

export interface AccountUpdate {
  pubkey: PublicKey;
  owner: PublicKey;
  data: Buffer;
  slot: number;
  stream: StreamName;
}

export interface TxLogsUpdate {
  signature: string;
  slot: number;
  logs: string[];
  failed: boolean;
  /**
   * Raw inner-instruction datas, when the source provides them (Yellowstone
   * streams them; the ws-rpc fallback fetches the transaction to fill this).
   * Needed because the program emits events via `emit_cpi!`, not logs.
   */
  innerIxDatas?: Uint8Array[] | undefined;
}

export interface StatusUpdate {
  connected: boolean;
  detail?: string;
}

/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
export interface IngestSource {
  on(event: "slot", listener: (u: SlotUpdate) => void): this;
  on(event: "account", listener: (u: AccountUpdate) => void): this;
  on(event: "txLogs", listener: (u: TxLogsUpdate) => void): this;
  on(event: "status", listener: (s: StatusUpdate) => void): this;
  emit(event: "slot", u: SlotUpdate): boolean;
  emit(event: "account", u: AccountUpdate): boolean;
  emit(event: "txLogs", u: TxLogsUpdate): boolean;
  emit(event: "status", s: StatusUpdate): boolean;
}

export abstract class IngestSource extends EventEmitter {
  private readonly lastSeen = new Map<StreamName, number>();

  /**
   * Only streams with continuous traffic can signal staleness by silence:
   * slots tick ~2-3×/s, while account/tx streams are quiet whenever nobody
   * plays. Hence slots is the default (and only) critical stream.
   */
  protected constructor(
    protected readonly stalenessMs: number,
    private readonly criticalStreams: StreamName[] = ["slots"],
  ) {
    super();
  }

  protected markSeen(stream: StreamName): void {
    this.lastSeen.set(stream, Date.now());
  }

  /** ms since the last update on the stream; Infinity if never seen. */
  lastUpdateAgeMs(stream: StreamName): number {
    const t = this.lastSeen.get(stream);
    return t === undefined ? Number.POSITIVE_INFINITY : Date.now() - t;
  }

  /** True when any critical stream has gone quiet past STALENESS_MS. */
  stale(): boolean {
    return this.criticalStreams.some((s) => this.lastUpdateAgeMs(s) > this.stalenessMs);
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
