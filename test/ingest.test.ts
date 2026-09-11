import { describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { accountsCoder, coder, EVENT_DISCRIMINATORS, type Round } from "../src/adapter/idl.js";
import {
  classifyAccount,
  decodeRoundStrict,
  HaltError,
  RoundMonotonicityGuard,
  TILES_COUNT,
  validateRoundShape,
} from "../src/ingest/decode.js";
import {
  EVENT_IX_TAG,
  isKnownEvent,
  parseCpiEventData,
  parseLogsToEvents,
  parseTransactionEvents,
} from "../src/ingest/events.js";

function makeRound(id: number, stakes: number[], deployCounts?: number[]): Round {
  return {
    version: 1,
    bump: 255,
    id,
    state: { Active: {} },
    blockhash_entropy: new Array<number>(32).fill(0),
    winning_tile: null,
    deployed_pending_usd_amount: new BN(0),
    deployed_usd_amount: new BN(0),
    deployed_btc_amount: new BN(0),
    deployed_usd_on_winning_tile_amount: new BN(0),
    miners_count: 0,
    revealed_miners_count: 0,
    winners_count: 0,
    settled_miners_count: 0,
    strike_bonus_usd: new BN(0),
    strike_bonus_btc: new BN(0),
    public_tile_stakes: stakes.map((s, i) => ({
      stake: new BN(s),
      deploy_count: deployCounts?.[i] ?? 0,
    })),
    minted_token_amount: new BN(0),
    strike_bonus_token: new BN(0),
    reserved_entropy: new Array<number>(16).fill(0),
    settled_at_slot: new BN(0),
    pending_epoch_fee_usd_amount: new BN(0),
    pending_one_btc_fee_usd_amount: new BN(0),
    pending_protocol_fee_usd_amount: new BN(0),
    is_hashrate_boosted: false,
    pending_affiliate_fee_usd_amount: new BN(0),
    pending_buybacks_fee_usd_amount: new BN(0),
    deployed_gross_usd_amount: new BN(0),
    reserved: new Array<number>(15).fill(0),
  };
}

const zeros = () => new Array<number>(TILES_COUNT).fill(0);

describe("round encode/decode round-trip against the IDL coder", () => {
  it("decodeRoundStrict accepts a coder-encoded Round and classify routes it", async () => {
    const round = makeRound(42, zeros());
    const buf = await accountsCoder.encode("Round", round);
    expect(classifyAccount(buf)).toBe("Round");
    const decoded = decodeRoundStrict(buf);
    expect(decoded.id).toBe(42);
    expect(decoded.public_tile_stakes).toHaveLength(TILES_COUNT);
    expect(decoded.winning_tile).toBeNull();
  });
});

describe("hard validation", () => {
  it("rejects a round with the wrong tile count", () => {
    const bad = makeRound(1, new Array<number>(20).fill(0));
    expect(() => validateRoundShape(bad)).toThrow(HaltError);
  });

  it("monotonicity guard: absorbs a fork rollback instead of halting", () => {
    // Observed live (round 15661, tile 0, -$0.448): we subscribe at `processed`,
    // which is pre-consensus, so a deploy can land on a fork that is then
    // abandoned. The smaller value is the truth, not corruption.
    const seen: unknown[] = [];
    const guard = new RoundMonotonicityGuard((r) => seen.push(r));
    const s1 = zeros();
    s1[4] = 27_523_642;
    guard.check(makeRound(7, s1));
    const s2 = [...s1];
    s2[4] = 40_000_000;
    guard.check(makeRound(7, s2)); // growth ok
    const s3 = [...s2];
    s3[4] = 27_075_398; // one small deploy unwound
    expect(guard.check(makeRound(7, s3))).toBe(true); // applied, not thrown
    expect(guard.rollbacks()).toBe(1);
    expect(seen).toEqual([
      { roundId: 7, tile: 4, droppedBase: "12924602", slot: undefined },
    ]);
    // Baseline moved DOWN, so the same value again is not a second rollback.
    expect(guard.check(makeRound(7, s3))).toBe(true);
    expect(guard.rollbacks()).toBe(1);
  });

  it("monotonicity guard: a shrinking deploy_count is a rollback, not a halt", () => {
    const guard = new RoundMonotonicityGuard();
    guard.check(makeRound(8, zeros(), [...zeros().slice(1), 3]));
    expect(guard.check(makeRound(8, zeros(), zeros()))).toBe(true);
    expect(guard.rollbacks()).toBe(1);
  });

  it("monotonicity guard: STILL halts when the board collapses", () => {
    // A fork unwinds a couple of slots. Losing over half the board cannot come
    // from that — it is a decode or layout failure, and that must stop the bot.
    const guard = new RoundMonotonicityGuard();
    const full = zeros().map(() => 30_000_000);
    guard.check(makeRound(12, full));
    const gutted = zeros().map(() => 1_000_000);
    expect(() => guard.check(makeRound(12, gutted))).toThrow(/collapsed/);
  });

  it("monotonicity guard: ignores a stale (older-slot) replay instead of halting", () => {
    // The live false-halt: an out-of-order/replayed account update from earlier
    // in the round shows tile 0 back at 0 after it had grown. With slot
    // ordering that is dropped as stale, not read as corruption.
    const guard = new RoundMonotonicityGuard();
    const grown = zeros();
    grown[0] = 3_570_503;
    expect(guard.check(makeRound(5809, grown), 1000)).toBe(true);
    // Replay of the round's initial state, stamped at an EARLIER slot.
    expect(guard.check(makeRound(5809, zeros()), 990)).toBe(false);
    // Same slot is also stale (no new information).
    expect(guard.check(makeRound(5809, zeros()), 1000)).toBe(false);
    // A newer slot still applies normally, and growth is fine.
    const more = zeros();
    more[0] = 4_000_000;
    expect(guard.check(makeRound(5809, more), 1001)).toBe(true);
  });

  it("monotonicity guard: a decrease at a NEWER slot is a rollback, not a halt", () => {
    const guard = new RoundMonotonicityGuard();
    const s1 = zeros();
    s1[2] = 9_000_000;
    s1[3] = 9_000_000;
    guard.check(makeRound(11, s1), 500);
    const s2 = [...s1];
    s2[2] = 8_000_000; // one tile unwinds; board total stays healthy
    expect(guard.check(makeRound(11, s2), 501)).toBe(true);
    expect(guard.rollbacks()).toBe(1);
  });

  it("monotonicity guard: a new round id resets the baseline", () => {
    const guard = new RoundMonotonicityGuard();
    const s1 = zeros();
    s1[0] = 5_000_000;
    guard.check(makeRound(9, s1));
    guard.check(makeRound(10, zeros())); // next round starts empty — fine
  });
});

describe("event parsing from program logs", () => {
  it("round-trips SatsClaimed through base64 program data", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const authority = Keypair.generate().publicKey;
    const payload = coder.types.encode("SatsClaimed", {
      authority,
      claimed_shares: new BN(123),
      btc_received: new BN(456),
      claimed_hashrate: new BN(7),
    });
    const disc = EVENT_DISCRIMINATORS["SatsClaimed"];
    expect(disc).toBeDefined();
    const line =
      "Program data: " + Buffer.concat([Buffer.from(disc!), payload]).toString("base64");
    const events = parseLogsToEvents(
      ["Program log: Instruction: ClaimSats", line],
      555,
      "sig111",
    );
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.name).toBe("SatsClaimed");
    expect(event.slot).toBe(555);
    expect(event.signature).toBe("sig111");
    expect(isKnownEvent(event)).toBe(true);
    const eventData = event.data as { claimed_shares: BN; authority: unknown };
    expect(eventData.claimed_shares.toNumber()).toBe(123);
  });

  it("decodes emit_cpi inner-instruction events (the path this program uses)", () => {
    const payload = coder.types.encode("RoundRevealed", {
      round_id: 1797,
      winning_tile: 13,
      is_strike_triggered: false,
      strike_bonus_usd: new BN(0),
      strike_bonus_btc: new BN(0),
      epoch_fee_usd_amount: new BN(262),
      one_btc_fee_usd_amount: new BN(132),
      protocol_fee_usd_amount: new BN(142),
    });
    const disc = EVENT_DISCRIMINATORS["RoundRevealed"]!;
    const cpiData = Buffer.concat([EVENT_IX_TAG, Buffer.from(disc), payload]);

    const single = parseCpiEventData(cpiData, 999, "sigCpi");
    expect(single?.name).toBe("RoundRevealed");

    const events = parseTransactionEvents({
      logs: ["Program log: Instruction: RotateRound"],
      innerIxDatas: [Uint8Array.from([1, 2, 3]), Uint8Array.from(cpiData)],
      slot: 999,
      signature: "sigCpi",
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.name).toBe("RoundRevealed");
    expect(isKnownEvent(event)).toBe(true);
    expect((event.data as { winning_tile: number }).winning_tile).toBe(13);
    expect(event.slot).toBe(999);
    expect(event.signature).toBe("sigCpi");
  });

  it("the emit_cpi tag matches the on-chain constant", () => {
    expect(EVENT_IX_TAG.toString("hex")).toBe("e445a52e51cb9a1d");
  });

  it("ignores foreign or malformed program data", () => {
    const events = parseLogsToEvents(
      [
        "Program data: aGVsbG8gd29ybGQ=", // wrong discriminator
        "Program data: !!!not-base64!!!",
        "Program log: something else",
      ],
      1,
      "sig",
    );
    expect(events).toHaveLength(0);
  });
});
