/**
 * Round-trip acceptance: build each instruction, decode it back with the IDL
 * instruction coder, and assert args + account ordering/flags/addresses match
 * the IDL's account list position by position.
 */
import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { BN } from "../src/adapter/idl.js";
import { instructionCoder, PROGRAM_ID, SATRUSH_IDL } from "../src/adapter/idl.js";
import {
  buildBuyEpochTickets,
  buildBuyOneBtcTickets,
  buildClaimEpochReward,
  buildClaimOneBtcReward,
  buildClaimSats,
  buildClaimUsd,
  buildDeployPublic,
  buildSelectEpochWinner,
  buildSettleDeployPublic,
  buildTriggerEpochDraw,
  buildTriggerOneBtcDraw,
  eventAuthorityPda,
  type InstructionContext,
} from "../src/adapter/instructions.js";
import { InvalidSelectionMaskError } from "../src/adapter/mask.js";
import {
  boardBtcAta,
  boardPda,
  boardUsdAta,
  epochVaultEntryPda,
  epochVaultIterationPda,
  epochVaultPagePda,
  epochVaultPda,
  minerPda,
  oneBtcVaultIterationPda,
  oneBtcVaultPda,
  publicAutomationPda,
  publicDeploymentPda,
  roundPda,
  satrushConfigPda,
  satsVaultBtcAta,
  satsVaultPda,
} from "../src/adapter/pdas.js";

const authority = Keypair.generate().publicKey;
const deployer = Keypair.generate().publicKey;
const usdMint = Keypair.generate().publicKey;
const btcMint = Keypair.generate().publicKey;
const ctx: InstructionContext = { usdMint, btcMint };
const ROUND_ID = 1797;

interface IdlIxAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}

function idlAccounts(ixName: string): IdlIxAccount[] {
  const idl = SATRUSH_IDL as unknown as {
    instructions: { name: string; accounts: IdlIxAccount[] }[];
  };
  const ix = idl.instructions.find((i) => i.name === ixName);
  expect(ix, `IDL instruction ${ixName}`).toBeDefined();
  return ix!.accounts;
}

/**
 * Position-by-position check of the built keys against the IDL account list:
 * length, writable/signer flags, IDL-declared fixed addresses, and every
 * account we can derive independently.
 */
function expectMatchesIdl(
  ixName: string,
  ix: TransactionInstruction,
  expected: Record<string, PublicKey>,
): void {
  const accounts = idlAccounts(ixName);
  expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
  expect(ix.keys, `${ixName} account count`).toHaveLength(accounts.length);
  const unmatched = new Set(Object.keys(expected));
  accounts.forEach((account, i) => {
    const key = ix.keys[i]!;
    expect(key.isWritable, `${ixName}.${account.name} writable`).toBe(
      account.writable === true,
    );
    expect(key.isSigner, `${ixName}.${account.name} signer`).toBe(
      account.signer === true,
    );
    if (account.address) {
      expect(key.pubkey.toBase58(), `${ixName}.${account.name} fixed address`).toBe(
        account.address,
      );
    }
    const want = expected[account.name];
    if (want) {
      expect(key.pubkey.toBase58(), `${ixName}.${account.name} derived address`).toBe(
        want.toBase58(),
      );
      unmatched.delete(account.name);
    }
  });
  expect([...unmatched], `${ixName}: expected accounts missing from IDL list`).toEqual(
    [],
  );
}

describe("deploy_public", () => {
  const mask = 0b1_0000_0000_0100_0001; // tiles 0, 6, 16
  const ix = buildDeployPublic(ctx, {
    authority,
    roundId: ROUND_ID,
    selectionMask: mask,
    amountBaseUnits: 1_500_000n,
  });

  it("decodes back to the same args", () => {
    const decoded = instructionCoder.decode(ix.data);
    expect(decoded?.name).toBe("deploy_public");
    const data = decoded!.data as { selection_mask: number; amount: BN };
    expect(data.selection_mask).toBe(mask);
    expect(data.amount.toString()).toBe("1500000");
  });

  it("matches the IDL account list", () => {
    expectMatchesIdl("deploy_public", ix, {
      authority,
      satrush_config: satrushConfigPda(),
      board: boardPda(),
      round: roundPda(ROUND_ID),
      usd_mint: usdMint,
      authority_usd_ata: getAssociatedTokenAddressSync(usdMint, authority),
      board_usd_ata: boardUsdAta(usdMint),
      public_deployment: publicDeploymentPda(authority, ROUND_ID),
      miner: minerPda(authority),
      event_authority: eventAuthorityPda(),
      program: PROGRAM_ID,
    });
  });

  it("rejects invalid masks and amounts before the wire", () => {
    const params = { authority, roundId: ROUND_ID, selectionMask: 0, amountBaseUnits: 1n };
    expect(() => buildDeployPublic(ctx, params)).toThrow(InvalidSelectionMaskError);
    expect(() =>
      buildDeployPublic(ctx, { ...params, selectionMask: 1 << 21 }),
    ).toThrow(InvalidSelectionMaskError);
    expect(() =>
      buildDeployPublic(ctx, { ...params, selectionMask: 1, amountBaseUnits: 0n }),
    ).toThrow(RangeError);
    expect(() =>
      buildDeployPublic(ctx, {
        ...params,
        selectionMask: 1,
        amountBaseUnits: 2n ** 64n,
      }),
    ).toThrow(/u64/);
  });
});

describe("settle_deploy_public", () => {
  const ix = buildSettleDeployPublic(ctx, {
    authority,
    deploymentAuthority: deployer,
    roundId: ROUND_ID,
  });

  it("decodes back with no args", () => {
    const decoded = instructionCoder.decode(ix.data);
    expect(decoded?.name).toBe("settle_deploy_public");
    expect(decoded!.data).toEqual({});
  });

  it("matches the IDL account list (PDAs seeded by the deployment authority)", () => {
    const automation = publicAutomationPda(deployer);
    expectMatchesIdl("settle_deploy_public", ix, {
      authority,
      satrush_config: satrushConfigPda(),
      round: roundPda(ROUND_ID),
      board: boardPda(),
      rent_recipient: authority, // defaulted to our wallet
      public_deployment: publicDeploymentPda(deployer, ROUND_ID),
      miner: minerPda(deployer),
      public_automation: automation,
      automation_usd_ata: getAssociatedTokenAddressSync(usdMint, automation, true),
      sats_vault: satsVaultPda(),
      btc_mint: btcMint,
      usd_mint: usdMint,
      board_usd_ata: boardUsdAta(usdMint),
      board_btc_ata: boardBtcAta(btcMint),
      sats_vault_btc_ata: satsVaultBtcAta(btcMint),
      event_authority: eventAuthorityPda(),
      program: PROGRAM_ID,
    });
  });

  it("honors an explicit rent recipient", () => {
    const recipient = Keypair.generate().publicKey;
    const withRecipient = buildSettleDeployPublic(ctx, {
      authority,
      deploymentAuthority: deployer,
      roundId: ROUND_ID,
      rentRecipient: recipient,
    });
    const position = idlAccounts("settle_deploy_public").findIndex(
      (a) => a.name === "rent_recipient",
    );
    expect(withRecipient.keys[position]!.pubkey.equals(recipient)).toBe(true);
  });
});

describe("claim_sats", () => {
  const ix = buildClaimSats(ctx, { authority, shares: 987_654_321n });

  it("decodes back to the same args", () => {
    const decoded = instructionCoder.decode(ix.data);
    expect(decoded?.name).toBe("claim_sats");
    expect((decoded!.data as { shares: BN }).shares.toString()).toBe("987654321");
  });

  it("matches the IDL account list", () => {
    expectMatchesIdl("claim_sats", ix, {
      authority,
      satrush_config: satrushConfigPda(),
      sats_vault: satsVaultPda(),
      miner: minerPda(authority),
      btc_mint: btcMint,
      sats_vault_btc_ata: satsVaultBtcAta(btcMint),
      authority_btc_ata: getAssociatedTokenAddressSync(btcMint, authority),
      event_authority: eventAuthorityPda(),
      program: PROGRAM_ID,
    });
  });
});

describe("claim_usd", () => {
  const ix = buildClaimUsd(ctx, { authority, amount: 250_000n });

  it("decodes back to the same args", () => {
    const decoded = instructionCoder.decode(ix.data);
    expect(decoded?.name).toBe("claim_usd");
    expect((decoded!.data as { amount: BN }).amount.toString()).toBe("250000");
  });

  it("matches the IDL account list (no event accounts — claim_usd emits none)", () => {
    expectMatchesIdl("claim_usd", ix, {
      authority,
      satrush_config: satrushConfigPda(),
      board: boardPda(),
      miner: minerPda(authority),
      usd_mint: usdMint,
      board_usd_ata: boardUsdAta(usdMint),
      authority_usd_ata: getAssociatedTokenAddressSync(usdMint, authority),
    });
    const names = idlAccounts("claim_usd").map((a) => a.name);
    expect(names).not.toContain("event_authority");
  });

  it("token program ids in the IDL match the spl-token constants we use", () => {
    for (const name of ["deploy_public", "claim_sats", "claim_usd"]) {
      for (const account of idlAccounts(name)) {
        if (account.name === "token_program") {
          expect(account.address).toBe(TOKEN_PROGRAM_ID.toBase58());
        }
        if (account.name === "associated_token_program") {
          expect(account.address).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
        }
      }
    }
  });
});

// ── hashrate-funded raffle vaults ───────────────────────────────────────────

const ITER = 7;
const PAGE = 2;
const ticket = Keypair.generate().publicKey;

describe("buy_one_btc_tickets", () => {
  const ix = buildBuyOneBtcTickets(ctx, {
    authority,
    iterationId: ITER,
    ticket,
    ticketsToBuy: 25n,
  });

  it("decodes back to the same args", () => {
    const decoded = instructionCoder.decode(ix.data);
    expect(decoded?.name).toBe("buy_one_btc_tickets");
    expect((decoded!.data as { tickets_to_buy: BN }).tickets_to_buy.toString()).toBe("25");
  });

  it("matches the IDL account list (ticket is a fresh signer)", () => {
    expectMatchesIdl("buy_one_btc_tickets", ix, {
      authority,
      miner: minerPda(authority),
      one_btc_vault: oneBtcVaultPda(),
      one_btc_vault_iteration: oneBtcVaultIterationPda(ITER),
      ticket,
      event_authority: eventAuthorityPda(),
      program: PROGRAM_ID,
    });
  });

  it("rejects a non-positive ticket count", () => {
    expect(() =>
      buildBuyOneBtcTickets(ctx, { authority, iterationId: ITER, ticket, ticketsToBuy: 0n }),
    ).toThrow(RangeError);
  });
});

describe("buy_epoch_tickets", () => {
  const ix = buildBuyEpochTickets(ctx, {
    authority,
    iterationId: ITER,
    pageIndex: PAGE,
    ticketsToBuy: 40n,
  });

  it("decodes back to the same args", () => {
    const decoded = instructionCoder.decode(ix.data);
    expect(decoded?.name).toBe("buy_epoch_tickets");
    const data = decoded!.data as { tickets_to_buy: BN; page_index: number };
    expect(data.tickets_to_buy.toString()).toBe("40");
    expect(data.page_index).toBe(PAGE);
  });

  it("matches the IDL account list", () => {
    expectMatchesIdl("buy_epoch_tickets", ix, {
      authority,
      miner: minerPda(authority),
      satrush_config: satrushConfigPda(),
      epoch_vault: epochVaultPda(),
      epoch_vault_iteration: epochVaultIterationPda(ITER),
      epoch_vault_page: epochVaultPagePda(ITER, PAGE),
      epoch_vault_entry: epochVaultEntryPda(ITER, authority),
      event_authority: eventAuthorityPda(),
      program: PROGRAM_ID,
    });
  });
});

describe("trigger_one_btc_draw", () => {
  const ix = buildTriggerOneBtcDraw(ctx, { authority, iterationId: ITER });

  it("decodes back with no args", () => {
    expect(instructionCoder.decode(ix.data)?.name).toBe("trigger_one_btc_draw");
  });

  it("matches the IDL account list, next iteration = current + 1", () => {
    expectMatchesIdl("trigger_one_btc_draw", ix, {
      authority,
      satrush_config: satrushConfigPda(),
      one_btc_vault: oneBtcVaultPda(),
      one_btc_vault_iteration: oneBtcVaultIterationPda(ITER),
      next_one_btc_vault_iteration: oneBtcVaultIterationPda(ITER + 1),
      slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY,
      event_authority: eventAuthorityPda(),
      program: PROGRAM_ID,
    });
  });
});

describe("trigger_epoch_draw", () => {
  const ix = buildTriggerEpochDraw(ctx, { authority, iterationId: ITER });

  it("matches the IDL account list, next iteration = current + 1", () => {
    expectMatchesIdl("trigger_epoch_draw", ix, {
      authority,
      satrush_config: satrushConfigPda(),
      epoch_vault: epochVaultPda(),
      epoch_vault_iteration: epochVaultIterationPda(ITER),
      next_epoch_vault_iteration: epochVaultIterationPda(ITER + 1),
      slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY,
      event_authority: eventAuthorityPda(),
      program: PROGRAM_ID,
    });
  });
});

describe("select_epoch_winner", () => {
  const ix = buildSelectEpochWinner(ctx, { authority, iterationId: ITER, pageIndex: PAGE });

  it("decodes back to the same args", () => {
    const decoded = instructionCoder.decode(ix.data);
    expect(decoded?.name).toBe("select_epoch_winner");
    expect((decoded!.data as { page_index: number }).page_index).toBe(PAGE);
  });

  it("matches the IDL account list (authority signs but is not writable)", () => {
    expectMatchesIdl("select_epoch_winner", ix, {
      authority,
      satrush_config: satrushConfigPda(),
      epoch_vault: epochVaultPda(),
      epoch_vault_iteration: epochVaultIterationPda(ITER),
      epoch_vault_page: epochVaultPagePda(ITER, PAGE),
      event_authority: eventAuthorityPda(),
      program: PROGRAM_ID,
    });
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(false);
  });
});

describe("claim_one_btc_reward", () => {
  const ix = buildClaimOneBtcReward(ctx, { authority, iterationId: ITER, ticket });

  it("matches the IDL account list and emits no event", () => {
    expectMatchesIdl("claim_one_btc_reward", ix, {
      authority,
      one_btc_vault: oneBtcVaultPda(),
      one_btc_vault_iteration: oneBtcVaultIterationPda(ITER),
      ticket,
      btc_mint: btcMint,
      one_btc_vault_btc_ata: getAssociatedTokenAddressSync(btcMint, oneBtcVaultPda(), true),
      authority_btc_ata: getAssociatedTokenAddressSync(btcMint, authority),
    });
    expect(idlAccounts("claim_one_btc_reward").map((a) => a.name)).not.toContain(
      "event_authority",
    );
  });
});

describe("claim_epoch_reward", () => {
  const ix = buildClaimEpochReward(ctx, { authority, iterationId: ITER });

  it("matches the IDL account list (USD + BTC payouts) and emits no event", () => {
    expectMatchesIdl("claim_epoch_reward", ix, {
      authority,
      epoch_vault: epochVaultPda(),
      epoch_vault_iteration: epochVaultIterationPda(ITER),
      usd_mint: usdMint,
      btc_mint: btcMint,
      epoch_vault_usd_ata: getAssociatedTokenAddressSync(usdMint, epochVaultPda(), true),
      epoch_vault_btc_ata: getAssociatedTokenAddressSync(btcMint, epochVaultPda(), true),
      authority_usd_ata: getAssociatedTokenAddressSync(usdMint, authority),
      authority_btc_ata: getAssociatedTokenAddressSync(btcMint, authority),
    });
    expect(idlAccounts("claim_epoch_reward").map((a) => a.name)).not.toContain(
      "event_authority",
    );
  });
});
