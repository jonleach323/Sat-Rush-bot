/**
 * Yellowstone gRPC ingest source. One subscription carries four streams:
 *  (a) slot updates at processed commitment,
 *  (b) program accounts filtered by the Board and Round discriminators
 *      (discriminator-filtered, so round rotation needs no resubscribe),
 *  (c) this wallet's Miner PDA + the SatsVault ("wallet" stream),
 *  (d) program transactions (log messages) for event capture.
 * Reconnects forever with exponential backoff + jitter. A silence watchdog
 * destroys a stream whose slot feed has gone quiet (a half-open connection
 * emits neither error nor end — the 2026-09-21 four-minute outage) so the
 * reconnect loop takes over.
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
  connect(): Promise<void>;
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
/** connect/subscribe must resolve within this or the attempt is abandoned —
 * a hung native connect would otherwise freeze the reconnect loop forever. */
const CONNECT_TIMEOUT_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 2_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    // deliberately NOT unref'd: the native connect promise does not hold the
    // event loop, so this timer must — otherwise the process can exit with
    // the await forever unsettled.
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export class YellowstoneIngest extends IngestSource {
  private stream: ClientDuplexStream | null = null;
  private endStream: (() => void) | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** When the current stream came up — silence is measured from here or the last slot, whichever is later. */
  private streamStartedAtMs = 0;
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
    const accounts: SubscribeRequest["accounts"] = {
      board: {
        account: [],
        owner: [program],
        filters: [{ memcmp: { offset: "0", bytes: accountDiscriminator("Board") } }],
      },
      round: {
        account: [],
        owner: [program],
        filters: [{ memcmp: { offset: "0", bytes: accountDiscriminator("Round") } }],
      },
    };
    // Only add the wallet group when there is something to watch — an empty
    // filter group ({account:[],owner:[],filters:[]}) matches EVERY account
    // on the cluster.
    if (this.opts.watchAccounts.length > 0) {
      accounts["wallet"] = {
        account: this.opts.watchAccounts.map((pk) => pk.toBase58()),
        owner: [],
        filters: [],
      };
    }
    return {
      accounts,
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
        // v5 requires an explicit connect before subscribe
        await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "grpc connect");
        const stream = await withTimeout(
          client.subscribe(this.buildRequest()),
          CONNECT_TIMEOUT_MS,
          "grpc subscribe",
        );
        this.stream = stream;
        stream.on("data", (update: SubscribeUpdate) => {
          this.attempt = 0; // live traffic resets the backoff
          this.handleUpdate(update);
        });
        this.streamStartedAtMs = Date.now();
        this.startPing();
        this.startWatchdog();
        this.emit("status", { connected: true });

        await new Promise<void>((resolve, reject) => {
          this.endStream = resolve; // teardown resolves this explicitly —
          // removeAllListeners must never leave the loop awaiting forever
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

  /** Silence grace before a stream is declared dead and rebuilt. */
  private watchdogGraceMs(): number {
    return Math.max(this.stalenessMs * 5, 7_500);
  }

  /**
   * Kill a stream whose slot feed has gone silent past the grace. The
   * connect loop sees the destroy as a stream error and reconnects with
   * backoff. Silence is measured from the later of the last slot and the
   * stream's own start, so a fresh stream gets the full grace and a dead
   * upstream is retried at the backoff cadence instead of every tick.
   */
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      const stream = this.stream;
      if (!stream || this.stopped) return;
      const quietFor = Math.min(this.lastUpdateAgeMs("slots"), Date.now() - this.streamStartedAtMs);
      const grace = this.watchdogGraceMs();
      if (quietFor <= grace) return;
      this.emit("status", {
        connected: false,
        detail: `slot stream silent ${Math.round(quietFor)}ms — rebuilding connection`,
      });
      stream.destroy(new Error(`watchdog: slot stream silent ${Math.round(quietFor)}ms`));
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  private teardownStream(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.stream) {
      this.endStream?.(); // settle the connect-loop's ended-promise first
      this.endStream = null;
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
