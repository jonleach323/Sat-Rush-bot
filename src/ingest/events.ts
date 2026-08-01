/**
 * Program logs / CPI data → typed Anchor events with slot + signature.
 *
 * The satrush program emits events via anchor's `emit_cpi!`: each event is a
 * self-CPI whose instruction data is [8-byte anchor event tag][8-byte event
 * discriminator][borsh payload] (verified against live devnet transactions).
 * The classic `emit!` path ("Program data: <base64>" log lines) is also
 * handled in case any instruction uses it.
 */
import { createHash } from "node:crypto";
import type {
  PublicDeployCreated,
  PublicDeploySettled,
  RoundRevealed,
  SatsClaimed,
} from "../adapter/idl.js";
import { eventCoder } from "../adapter/idl.js";

export interface DecodedEvent<TName extends string = string, TData = unknown> {
  name: TName;
  data: TData;
  slot: number;
  signature: string;
}

export type KnownSatrushEvent =
  | DecodedEvent<"PublicDeployCreated", PublicDeployCreated>
  | DecodedEvent<"RoundRevealed", RoundRevealed>
  | DecodedEvent<"PublicDeploySettled", PublicDeploySettled>
  | DecodedEvent<"SatsClaimed", SatsClaimed>;

const KNOWN_EVENT_NAMES = new Set<string>([
  "PublicDeployCreated",
  "RoundRevealed",
  "PublicDeploySettled",
  "SatsClaimed",
]);

const PROGRAM_DATA_PREFIX = "Program data: ";

/**
 * Anchor's `emit_cpi!` instruction tag: the little-endian u64 taken from
 * sha256("anchor:event")[0..8]. Derived, not hardcoded — and verified against
 * live devnet CPI data (e445a52e51cb9a1d).
 */
export const EVENT_IX_TAG: Buffer = (() => {
  const digest = createHash("sha256").update("anchor:event").digest();
  return Buffer.from(digest.subarray(0, 8)).reverse();
})();

function decodeEventBytes(
  bytes: Buffer,
  slot: number,
  signature: string,
): DecodedEvent | null {
  let decoded: { name: string; data: unknown } | null;
  try {
    decoded = eventCoder.decode(bytes.toString("base64"));
  } catch {
    return null; // foreign or malformed event data
  }
  return decoded ? { name: decoded.name, data: decoded.data, slot, signature } : null;
}

/** Decode every `emit!`-style event in a transaction's log messages. */
export function parseLogsToEvents(
  logs: string[],
  slot: number,
  signature: string,
): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), "base64");
    } catch {
      continue;
    }
    const event = decodeEventBytes(bytes, slot, signature);
    if (event) out.push(event);
  }
  return out;
}

/** Decode one `emit_cpi!` inner-instruction data blob, or null. */
export function parseCpiEventData(
  data: Uint8Array,
  slot: number,
  signature: string,
): DecodedEvent | null {
  const buf = Buffer.from(data);
  if (buf.length < 16 || !buf.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
  return decodeEventBytes(buf.subarray(8), slot, signature);
}

/** All events of a transaction, from both emit paths. */
export function parseTransactionEvents(tx: {
  logs: string[];
  innerIxDatas?: Uint8Array[] | undefined;
  slot: number;
  signature: string;
}): DecodedEvent[] {
  const out = parseLogsToEvents(tx.logs, tx.slot, tx.signature);
  for (const data of tx.innerIxDatas ?? []) {
    const event = parseCpiEventData(data, tx.slot, tx.signature);
    if (event) out.push(event);
  }
  return out;
}

export function isKnownEvent(event: DecodedEvent): event is KnownSatrushEvent {
  return KNOWN_EVENT_NAMES.has(event.name);
}
