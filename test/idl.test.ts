import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DISCRIMINATORS,
  EVENT_DISCRIMINATORS,
  PROGRAM_ADDRESS,
  PROGRAM_ID,
  accountsCoder,
  coder,
  eventCoder,
  instructionCoder,
  pdaConstSeed,
} from "../src/adapter/idl.js";

describe("IDL loading", () => {
  it("program id matches the IDL address", () => {
    expect(PROGRAM_ID.toBase58()).toBe(PROGRAM_ADDRESS);
  });

  it("coders construct from the IDL", () => {
    expect(coder).toBeDefined();
    expect(accountsCoder).toBeDefined();
    expect(instructionCoder).toBeDefined();
    expect(eventCoder).toBeDefined();
  });
});

describe("discriminators from the IDL", () => {
  it("covers the accounts the client decodes", () => {
    for (const name of [
      "Board",
      "Round",
      "Miner",
      "PublicDeployment",
      "PublicAutomation",
      "SatrushConfig",
      "SatsVault",
      "OneBtcVault",
      "OneBtcVaultIteration",
      "OneBtcVaultEntry",
      "EpochVault",
      "EpochVaultIteration",
      "EpochVaultEntry",
      "EpochVaultPage",
    ]) {
      expect(ACCOUNT_DISCRIMINATORS[name], name).toBeInstanceOf(Uint8Array);
      expect(ACCOUNT_DISCRIMINATORS[name], name).toHaveLength(8);
    }
  });

  it("covers the events the client ingests", () => {
    for (const name of [
      "PublicDeployCreated",
      "RoundRevealed",
      "PublicDeploySettled",
      "SatsClaimed",
    ]) {
      expect(EVENT_DISCRIMINATORS[name], name).toBeInstanceOf(Uint8Array);
      expect(EVENT_DISCRIMINATORS[name], name).toHaveLength(8);
    }
  });
});

describe("PDA seed constants from the IDL", () => {
  it("exposes the expected seed prefixes", () => {
    const decode = (b: Uint8Array) => Buffer.from(b).toString("utf8");
    expect(decode(pdaConstSeed("satrush_config"))).toBe("satrush_config");
    expect(decode(pdaConstSeed("board"))).toBe("board");
    expect(decode(pdaConstSeed("round"))).toBe("round");
    expect(decode(pdaConstSeed("miner"))).toBe("miner");
    expect(decode(pdaConstSeed("public_deployment"))).toBe("public_deployment");
    expect(decode(pdaConstSeed("public_automation"))).toBe("public_automation");
    expect(decode(pdaConstSeed("sats_vault"))).toBe("sats_vault");
    expect(decode(pdaConstSeed("one_btc_vault"))).toBe("one_btc_vault");
    expect(decode(pdaConstSeed("epoch_vault"))).toBe("epoch_vault");
    expect(decode(pdaConstSeed("epoch_vault_page"))).toBe("epoch_vault_page");
    expect(decode(pdaConstSeed("epoch_vault_entry"))).toBe("epoch_vault_entry");
  });

  it("throws on unknown account names", () => {
    expect(() => pdaConstSeed("not_a_real_account")).toThrow(/no const PDA seed/);
  });
});
