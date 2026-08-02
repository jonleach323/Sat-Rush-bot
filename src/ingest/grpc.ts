/**
 * Yellowstone gRPC ingest source. One subscription carries four streams:
 *  (a) slot updates at processed commitment,
 *  (b) program accounts filtered by the Board and Round discriminators
 *      (discriminator-filtered, so round rotation needs no resubscribe),
 *  (c) this wallet's Miner PDA + the SatsVault ("wallet" stream),
 *  (d) program transactions (log messages) for event capture.
 * Reconnects forever with exponential backoff + jitter.
 */
import * as yellowstoneNs from "@triton-one/yellowstone-grpc";
import type {
  ClientDuplexStream,
  SubscribeRequest,
  SubscribeUpdate,
} from "@triton-one/yellowstone-grpc";

// CJS package under NodeNext ESM: depending on the loader's interop the real
// module surfaces either as the namespace itself (esbuild) or under its
// `default` binding (raw Node). Normalize once; the client class then always
// sits on the module's `default`.
interface YellowstoneClient {
  subscribe(request?: SubscribeRequest): Promise<ClientDuplexStream>;
}
type YellowstoneClientCtor = new (
  endpoint: string,
  xToken: string | undefined,
  channelOptions: undefined,
  reconnectOptions?: { enabled?: boolean },
) => YellowstoneClient;

const nsDefault = (yellowstoneNs as { default?: unknown }).default;
const yellowstone = (
  typeof nsDefault === "object" && nsDefault !== null && "CommitmentLevel" in nsDefault
    ? nsDefault
    : yellowstoneNs
) as typeof yellowstoneNs & { default: unknown };
const CommitmentLevel = yellowstone.CommitmentLevel;
const Client = yellowstone.default as unknown as YellowstoneClientCtor;
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { accountDiscriminator } from "../adapter/idl.js";
import { IngestSource, type StreamName } from "./types.js";

export interface YellowstoneIngestOptions {
  endpoint: string;
  xToken?: string | undefined;
  programId: PublicKey;
  /** Extra accounts to watch verbatim: this wallet's Miner PDA, SatsVault. */
  watchAccounts: PublicKey[];
  stalenessMs: number;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class YellowstoneIngest extends IngestSource {
  private stream: ClientDuplexStream | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;
  private runLoop: Promise<void> | null = null;

  constructor(private readonly opts: YellowstoneIngestOptions) {
    super(opts.stalenessMs);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.runLoop = this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.teardownStream();
    await this.runLoop?.catch(() => undefined);
  }

  /** Chaos hook: destroy the stream; the reconnect loop takes over. */
  simulateDisconnect(): void {
    this.stream?.destroy(new Error("chaos: forced disconnect"));
  }

  private buildRequest(): SubscribeRequest {
    const program = this.opts.programId.toBase58();
    return {
      accounts: {
        board: {
          account: [],
          owner: [program],
          filters: [
            { memcmp: { offset: "0", bytes: accountDiscriminator("Board") } },
          ],
        },
        round: {
          account: [],
          owner: [program],
          filters: [
            { memcmp: { offset: "0", bytes: accountDiscriminator("Round") } },
          ],
        },
        wallet: {
          account: this.opts.watchAccounts.map((pk) => pk.toBase58()),
          owner: [],
          filters: [],
        },
      },
      slots: {
        client: { filterByCommitment: true },
      },
      transactions: {
        satrush: {
          vote: false,
          failed: false,
          accountInclude: [program],
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
    };
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        // Own reconnect policy — disable the SDK's built-in one.
        const client = new Client(this.opts.endpoint, this.opts.xToken, undefined, {
          enabled: false,
        });
        const stream = await client.subscribe(this.buildRequest());
        this.stream = stream;
        stream.on("data", (update: SubscribeUpdate) => {
          this.attempt = 0; // live traffic resets the backoff
          this.handleUpdate(update);
        });
        this.startPing();
        this.emit("status", { connected: true });

        await new Promise<void>((resolve, reject) => {
          stream.once("error", reject);
          stream.once("end", resolve);
          stream.once("close", resolve);
        });
        if (!this.stopped) this.emit("status", { connected: false, detail: "stream ended" });
      } catch (err) {
        if (!this.stopped) {
          this.emit("status", { connected: false, detail: String(err) });
        }
      } finally {
        this.teardownStream();
      }
      if (this.stopped) return;
      await sleep(this.nextBackoffMs());
    }
  }

  /** Exponential backoff with full jitter: base·2^attempt scaled by 0.5–1.5. */
  private nextBackoffMs(): number {
    const exp = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    this.attempt = Math.min(this.attempt + 1, 10);
    return Math.round(exp * (0.5 + Math.random()));
  }

  private startPing(): void {
    let pingId = 0;
    this.pingTimer = setInterval(() => {
      this.stream?.write({
        accounts: {},
        slots: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        ping: { id: ++pingId },
      } satisfies SubscribeRequest);
    }, PING_INTERVAL_MS);
  }

  private teardownStream(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.stream) {
      this.stream.removeAllListeners();
      try {
        this.stream.destroy();
      } catch {
        /* already closed */
      }
      this.stream = null;
    }
  }

  private handleUpdate(update: SubscribeUpdate): void {
    if (update.slot) {
      this.markSeen("slots");
      this.emit("slot", { slot: Number(update.slot.slot) });
      return;
    }
    if (update.account?.account) {
      const stream: StreamName = update.filters.includes("wallet") ? "wallet" : "accounts";
      this.markSeen(stream);
      const info = update.account.account;
      this.emit("account", {
        pubkey: new PublicKey(info.pubkey),
        owner: new PublicKey(info.owner),
        data: Buffer.from(info.data),
        slot: Number(update.account.slot),
        stream,
      });
      return;
    }
    if (update.transaction?.transaction) {
      this.markSeen("transactions");
      const info = update.transaction.transaction;
      this.emit("txLogs", {
        signature: bs58.encode(info.signature),
        slot: Number(update.transaction.slot),
        logs: info.meta?.logMessages ?? [],
        failed: info.meta?.err !== undefined,
        innerIxDatas: (info.meta?.innerInstructions ?? []).flatMap((group) =>
          group.instructions.map((ix) => ix.data),
        ),
      });
    }
    // pings/pongs and other update kinds are connection chatter — ignored.
  }
}
