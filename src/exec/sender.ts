/**
 * Race-send protocol. On fire, the same signed bytes go simultaneously to
 * every configured RPC (skipPreflight, maxRetries 0) and — when a Jito
 * block engine is configured — as a bundle. Resends every 400ms until
 * confirmed at processed, the round cutoff passes, or 10s elapse. The
 * signature is identical everywhere, so duplicate landings are impossible.
 *
 * EXECUTION_MODE gate (CLAUDE.md ground rule): in dry mode NOTHING touches
 * the wire — the would-be send is logged and a synthetic confirmation
 * returned. mainnet additionally requires MAINNET_CONFIRM=yes, enforced at
 * config load.
 */
import type { Connection } from "@solana/web3.js";
import type { Logger } from "pino";
import { confirmSignature, type ConfirmOutcome } from "./confirm.js";

export type ExecutionMode = "dry" | "devnet" | "mainnet";

export interface FireCandidate {
  signature: string;
  serialized: Buffer | Uint8Array;
  lastValidBlockHeight?: number | undefined;
  /** For logging only. */
  meta?: Record<string, unknown> | undefined;
}

export interface FireOptions {
  /** Round cutoff check — stop resending once it returns true. */
  isPastCutoff?: (() => boolean) | undefined;
  timeoutMs?: number | undefined;
  resendIntervalMs?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface FireResult {
  outcome: ConfirmOutcome["status"] | "dry";
  detail?: string | undefined;
  signature: string;
  landedSlot?: number | undefined;
  timing: {
    firedAtMs: number;
    resolvedAtMs: number;
    sendAttempts: number;
    perEndpointSends: number;
  };
}

export interface RaceSenderOptions {
  mode: ExecutionMode;
  connections: Connection[];
  jitoUrl?: string | undefined;
  logger?: Logger | undefined;
}

const RESEND_INTERVAL_MS = 400;
const FIRE_TIMEOUT_MS = 10_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RaceSender {
  constructor(private readonly opts: RaceSenderOptions) {
    if (opts.mode !== "dry" && opts.connections.length === 0) {
      throw new Error("RaceSender needs at least one connection outside dry mode");
    }
  }

  async fire(candidate: FireCandidate, fireOpts: FireOptions = {}): Promise<FireResult> {
    const now = fireOpts.now ?? Date.now;
    const sleep = fireOpts.sleep ?? defaultSleep;
    const firedAtMs = now();

    // ── dry mode: log the would-be send, never touch the wire ──────────────
    if (this.opts.mode === "dry") {
      this.opts.logger?.info(
        { signature: candidate.signature, ...candidate.meta },
        "DRY RUN — would fire pre-signed transaction",
      );
      return {
        outcome: "dry",
        signature: candidate.signature,
        timing: { firedAtMs, resolvedAtMs: now(), sendAttempts: 0, perEndpointSends: 0 },
      };
    }

    const bytes = Buffer.from(candidate.serialized);
    const primary = this.opts.connections[0]!;
    let sendAttempts = 0;

    const blastOnce = () => {
      sendAttempts++;
      for (const connection of this.opts.connections) {
        connection
          .sendRawTransaction(bytes, { skipPreflight: true, maxRetries: 0 })
          .catch(() => undefined); // duplicates/transient errors are harmless
      }
      if (this.opts.jitoUrl) void this.sendJitoBundle(bytes);
    };

    const confirmPromise = confirmSignature(primary, candidate.signature, {
      timeoutMs: fireOpts.timeoutMs ?? FIRE_TIMEOUT_MS,
      isPastCutoff: fireOpts.isPastCutoff,
      lastValidBlockHeight: candidate.lastValidBlockHeight,
      now,
      sleep,
    });

    // Resend loop racing the confirmation.
    let resolved: ConfirmOutcome | null = null;
    void confirmPromise.then((o) => (resolved = o));
    const timeoutMs = fireOpts.timeoutMs ?? FIRE_TIMEOUT_MS;
    const interval = fireOpts.resendIntervalMs ?? RESEND_INTERVAL_MS;
    while (resolved === null && now() - firedAtMs <= timeoutMs) {
      if (fireOpts.isPastCutoff?.() && sendAttempts > 0) break; // stop blasting past cutoff
      blastOnce();
      await sleep(interval);
    }
    const outcome = await confirmPromise;

    const result: FireResult = {
      outcome: outcome.status,
      signature: candidate.signature,
      landedSlot: outcome.status === "landed" ? outcome.slot : undefined,
      detail:
        outcome.status === "missed_round"
          ? outcome.reason
          : outcome.status === "failed"
            ? outcome.error
            : undefined,
      timing: {
        firedAtMs,
        resolvedAtMs: now(),
        sendAttempts,
        perEndpointSends: sendAttempts * this.opts.connections.length,
      },
    };
    this.opts.logger?.info(
      { ...result, meta: candidate.meta },
      `fire resolved: ${result.outcome}`,
    );
    return result;
  }

  private async sendJitoBundle(bytes: Buffer): Promise<void> {
    try {
      await fetch(`${this.opts.jitoUrl}/api/v1/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [[bytes.toString("base64")], { encoding: "base64" }],
        }),
      });
    } catch {
      /* Jito is a bonus path — RPC race carries the send */
    }
  }
}
