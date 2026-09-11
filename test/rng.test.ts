/**
 * Rotor remaining-account parity: our sync derivation must equal the SDK's
 * `getRngRemainingAccountsFor` for every rotor tag (program id, seeds, order,
 * writability). Anything else and every arming instruction fails on chain.
 */
import { describe, expect, it } from "vitest";
import { getRngRemainingAccountsFor } from "@satrush/client";
import { rngRemainingAccounts, ROTOR_TAGS } from "../src/adapter/rng.js";

describe("rng remaining accounts match the SDK", () => {
  for (const tag of Object.values(ROTOR_TAGS)) {
    it(`rotor "${tag}"`, async () => {
      const sdk = await getRngRemainingAccountsFor(tag);
      const ours = rngRemainingAccounts(tag);
      expect(ours.map((m) => m.pubkey.toBase58())).toEqual(sdk.map((a) => String(a.address)));
      // @solana/kit AccountRole is a bitmask: bit 0 = writable, bit 1 = signer.
      expect(ours.map((m) => m.isWritable)).toEqual(sdk.map((a) => (Number(a.role) & 1) === 1));
      expect(sdk.every((a) => (Number(a.role) & 2) === 0)).toBe(true);
      expect(ours.every((m) => !m.isSigner)).toBe(true);
    });
  }
});
