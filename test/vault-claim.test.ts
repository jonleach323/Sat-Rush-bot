import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  epochAction,
  epochWinIndex,
  epochWinnerPageIndex,
  oneBtcAction,
  oneBtcHoldsWinner,
} from "../src/strategy/vault-claim.js";

const me = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;

describe("epochWinIndex", () => {
  it("finds our first unclaimed win", () => {
    const winners = [
      { authority: other, distributed: false },
      { authority: me, distributed: false },
      { authority: me, distributed: true },
    ];
    expect(epochWinIndex(winners, me)).toBe(1);
  });
  it("ignores already-claimed wins and non-wins", () => {
    expect(epochWinIndex([{ authority: me, distributed: true }], me)).toBe(-1);
    expect(epochWinIndex([{ authority: other, distributed: false }], me)).toBe(-1);
  });
});

describe("oneBtcHoldsWinner", () => {
  const entries = [
    { startTicketId: 100n, ticketsCount: 10n }, // [100,110)
    { startTicketId: 500n, ticketsCount: 5n }, // [500,505)
  ];
  it("true when a range contains the winning ticket", () => {
    expect(oneBtcHoldsWinner(104n, entries)).toBe(true);
    expect(oneBtcHoldsWinner(500n, entries)).toBe(true);
  });
  it("false at range boundaries and gaps", () => {
    expect(oneBtcHoldsWinner(110n, entries)).toBe(false); // exclusive upper
    expect(oneBtcHoldsWinner(300n, entries)).toBe(false);
  });
});

describe("epochWinnerPageIndex", () => {
  const pages = [
    { pageIndex: 0, cumulativeBase: 0n, totalTickets: 320n }, // [0,320)
    { pageIndex: 1, cumulativeBase: 320n, totalTickets: 200n }, // [320,520)
  ];
  it("locates the page holding the ticket", () => {
    expect(epochWinnerPageIndex(pages, 5n)).toBe(0);
    expect(epochWinnerPageIndex(pages, 400n)).toBe(1);
  });
  it("returns -1 when out of range", () => {
    expect(epochWinnerPageIndex(pages, 999n)).toBe(-1);
  });
});

describe("epochAction", () => {
  const base = {
    windowElapsed: true,
    winnersSelected: 0,
    winnersTarget: 21,
    weWon: false,
    selfCrank: true,
  };
  it("triggers an elapsed open draw when self-cranking", () => {
    expect(epochAction({ ...base, state: "Open" })).toBe("trigger");
    expect(epochAction({ ...base, state: "Open", windowElapsed: false })).toBe("wait");
    expect(epochAction({ ...base, state: "Open", selfCrank: false })).toBe("wait");
  });
  it("selects winners while settling", () => {
    expect(epochAction({ ...base, state: "Settling" })).toBe("select");
    expect(epochAction({ ...base, state: "Settling", winnersSelected: 21 })).toBe("wait");
  });
  it("claims when settled and we won, else done", () => {
    expect(epochAction({ ...base, state: "Settled", weWon: true })).toBe("claim");
    expect(epochAction({ ...base, state: "Settled", weWon: false })).toBe("done");
    expect(epochAction({ ...base, state: "Complete", weWon: true })).toBe("claim");
  });
});

describe("oneBtcAction", () => {
  const base = { triggerable: true, weWon: false, selfCrank: true };
  it("triggers a full open vault when self-cranking", () => {
    expect(oneBtcAction({ ...base, state: "Open" })).toBe("trigger");
    expect(oneBtcAction({ ...base, state: "Open", triggerable: false })).toBe("wait");
    expect(oneBtcAction({ ...base, state: "Open", selfCrank: false })).toBe("wait");
  });
  it("claims when settled and we hold the winner, else done", () => {
    expect(oneBtcAction({ ...base, state: "Settled", weWon: true })).toBe("claim");
    expect(oneBtcAction({ ...base, state: "Settled", weWon: false })).toBe("done");
  });
});
