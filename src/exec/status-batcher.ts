/**
 * One getSignatureStatuses call per tick for every pending signature.
 * A 21-leg fleet send confirms 21 signatures at once; polling each on its
 * own (every 250 ms) was ~84 status requests a second, on the same RPC
 * plan as the sends, in the one second that decides whether they land.
 * The batcher coalesces requests made within `windowMs` into one call
 * (chunked at the RPC's 256-signature limit) and hands each caller its
 * own slice. Everything else on the connection passes through untouched.
 */
import type { Connection, SignatureStatus, RpcResponseAndContext } from "@solana/web3.js";

type StatusResponse = RpcResponseAndContext<(SignatureStatus | null)[]>;

interface Waiter {
  signatures: string[];
  resolve: (r: StatusResponse) => void;
  reject: (e: unknown) => void;
}

const MAX_PER_CALL = 256;

export class SignatureStatusBatcher {
  private queue: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Calls actually made to the RPC (for tests and /health). */
  calls = 0;

  private scheduled = false;

  /**
   * `windowMs` 0 flushes on the next microtask (coalesces polls issued in
   * the same tick — safe under fake clocks); > 0 waits that long, which
   * also coalesces the 21 confirm loops waking from their own timers.
   */
  constructor(private readonly connection: Pick<Connection, "getSignatureStatuses">, private readonly windowMs = 0) {}

  getSignatureStatuses(signatures: string[]): Promise<StatusResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ signatures, resolve, reject });
      if (this.scheduled) return;
      this.scheduled = true;
      if (this.windowMs > 0) this.timer = setTimeout(() => void this.flush(), this.windowMs);
      else queueMicrotask(() => void this.flush());
    });
  }

  private async flush(): Promise<void> {
    this.timer = null;
    this.scheduled = false;
    const waiters = this.queue;
    this.queue = [];
    const unique = [...new Set(waiters.flatMap((w) => w.signatures))];
    const statuses = new Map<string, SignatureStatus | null>();
    let context = { slot: 0 };
    try {
      for (let i = 0; i < unique.length; i += MAX_PER_CALL) {
        const chunk = unique.slice(i, i + MAX_PER_CALL);
        this.calls++;
        const res = await this.connection.getSignatureStatuses(chunk);
        context = res.context;
        chunk.forEach((s, j) => statuses.set(s, res.value[j] ?? null));
      }
    } catch (err) {
      for (const w of waiters) w.reject(err);
      return;
    }
    for (const w of waiters) w.resolve({ context, value: w.signatures.map((s) => statuses.get(s) ?? null) });
  }
}

/** A Connection whose getSignatureStatuses goes through a batcher; every other method is the original's. */
export function withBatchedStatuses(connection: Connection, batcher: SignatureStatusBatcher): Connection {
  return new Proxy(connection, {
    get(target, prop, receiver) {
      if (prop === "getSignatureStatuses") return (sigs: string[]) => batcher.getSignatureStatuses(sigs);
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
