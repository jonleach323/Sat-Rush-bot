/**
 * Shape tests only: PDAs derive without throwing, are 32-byte off-curve keys,
 * and are deterministic. Correctness against on-chain accounts is verified in
 * Stage 9 (devnet experiments).
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  boardBtcAta,
  boardPda,
  boardUsdAta,
  minerPda,
  publicAutomationPda,
  publicDeploymentPda,
  roundPda,
  satrushConfigPda,
  satsVaultBtcAta,
  satsVaultPda,
} from "../src/adapter/pdas.js";

const authority = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

function expectValidKey(pk: PublicKey, offCurve = true) {
  expect(pk).toBeInstanceOf(PublicKey);
  expect(pk.toBytes()).toHaveLength(32);
  if (offCurve) expect(PublicKey.isOnCurve(pk.toBytes())).toBe(false);
}

describe("singleton PDAs", () => {
  it.each([
    ["satrush_config", satrushConfigPda],
    ["board", boardPda],
    ["sats_vault", satsVaultPda],
  ] as const)("%s derives a 32-byte off-curve key", (_name, fn) => {
    expectValidKey(fn());
    expect(fn().equals(fn())).toBe(true); // deterministic
  });
});

describe("round PDA (u32 LE round id)", () => {
  it("derives for boundary round ids", () => {
    for (const id of [0, 1, 1234, 0xffff_ffff]) {
      expectValidKey(roundPda(id));
    }
  });

  it("distinct round ids give distinct addresses", () => {
    expect(roundPda(1).equals(roundPda(2))).toBe(false);
  });

  it("rejects non-u32 round ids", () => {
    expect(() => roundPda(-1)).toThrow(RangeError);
    expect(() => roundPda(0x1_0000_0000)).toThrow(RangeError);
    expect(() => roundPda(1.5)).toThrow(RangeError);
  });
});

describe("authority-scoped PDAs", () => {
  it("miner derives per authority", () => {
    expectValidKey(minerPda(authority));
    const other = Keypair.generate().publicKey;
    expect(minerPda(authority).equals(minerPda(other))).toBe(false);
  });

  it("public_automation derives per authority", () => {
    expectValidKey(publicAutomationPda(authority));
  });

  it("public_deployment derives per (authority, round)", () => {
    expectValidKey(publicDeploymentPda(authority, 7));
    expect(
      publicDeploymentPda(authority, 7).equals(publicDeploymentPda(authority, 8)),
    ).toBe(false);
    const other = Keypair.generate().publicKey;
    expect(
      publicDeploymentPda(authority, 7).equals(publicDeploymentPda(other, 7)),
    ).toBe(false);
  });
});

describe("program-owned ATAs", () => {
  it("board/vault ATAs derive as 32-byte off-curve keys", () => {
    expectValidKey(boardUsdAta(mint));
    expectValidKey(boardBtcAta(mint));
    expectValidKey(satsVaultBtcAta(mint));
    // board USD and BTC ATA differ only by mint; same mint → same address
    expect(boardUsdAta(mint).equals(boardBtcAta(mint))).toBe(true);
  });
});
