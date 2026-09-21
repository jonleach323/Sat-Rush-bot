/**
 * Instruction builders. Account lists mirror the IDL's account order and
 * writable/signer flags exactly (round-trip-tested against the IDL); all
 * addresses are derived — PDAs via pdas.ts, ATAs via the associated-token
 * program, fixed programs from the IDL's declared addresses.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN, instructionCoder, PROGRAM_ID } from "./idl.js";
import { validateMask } from "./mask.js";
import { rngRemainingAccounts, ROTOR_TAGS } from "./rng.js";
import {
  affiliatePda,
  affiliateTagPda,
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
  tokenVaultPda,
  treasuryPda,
} from "./pdas.js";

/**
 * Anchor's emit_cpi! event authority: PDA of the framework-constant seed
 * "__event_authority" under the program (the IDL lists the account without
 * seeds because it's an Anchor convention; verified against live devnet
 * transactions).
 */
export function eventAuthorityPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  )[0];
}

/** Mints (from the on-chain SatrushConfig) + optional program override. */
export interface InstructionContext {
  usdMint: PublicKey;
  btcMint: PublicKey;
  /** RUSH mint (SatrushConfig.token_mint) — V2 settle/claim legs. */
  tokenMint: PublicKey;
  programId?: PublicKey | undefined;
}

/**
 * Anchor optional account left empty: the SDK's "programId" strategy puts the
 * program id in the slot, read-only and unsigned, whatever the IDL flags say.
 */
const absent = (programId: PublicKey): AccountMeta => meta(programId);

const meta = (pubkey: PublicKey, writable = false, signer = false): AccountMeta => ({
  pubkey,
  isWritable: writable,
  isSigner: signer,
});

function toBn(value: bigint, label: string): BN {
  if (value <= 0n) throw new RangeError(`${label} must be positive, got ${value}`);
  if (value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} exceeds u64: ${value}`);
  }
  return new BN(value.toString());
}

export interface DeployPublicParams {
  authority: PublicKey;
  roundId: number;
  selectionMask: number;
  amountBaseUnits: bigint;
  /**
   * Fund from the Miner's grubstake USD ATA instead of the wallet ATA
   * (`is_grubstake_funded`). Default false.
   */
  isGrubstakeFunded?: boolean | undefined;
  /**
   * Affiliate whose tag this wallet plays under. Only binds at Miner
   * creation (first deploy); later deploys ignore it. Absent → program id
   * in the optional slot.
   */
  affiliateAuthority?: PublicKey | undefined;
}

export function buildDeployPublic(
  ctx: InstructionContext,
  params: DeployPublicParams,
): TransactionInstruction {
  validateMask(params.selectionMask);
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, roundId } = params;
  const board = boardPda(programId);
  const miner = minerPda(authority, programId);
  const isGrubstakeFunded = params.isGrubstakeFunded === true;
  const fundingUsdAta = isGrubstakeFunded
    ? getAssociatedTokenAddressSync(ctx.usdMint, miner, true)
    : getAssociatedTokenAddressSync(ctx.usdMint, authority);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(board, true),
      meta(roundPda(roundId, programId), true),
      meta(ctx.usdMint),
      meta(fundingUsdAta, true),
      meta(boardUsdAta(ctx.usdMint, programId), true),
      meta(publicDeploymentPda(authority, roundId, programId), true),
      meta(miner, true),
      params.affiliateAuthority
        ? meta(affiliatePda(params.affiliateAuthority, programId))
        : absent(programId),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
      // V2: the deploy arms the round rotor by CPI.
      ...rngRemainingAccounts(ROTOR_TAGS.round),
    ],
    data: instructionCoder.encode("deploy_public", {
      selection_mask: params.selectionMask,
      amount: toBn(params.amountBaseUnits, "amount"),
      is_grubstake_funded: isGrubstakeFunded,
    }),
  });
}

export interface SettleDeployPublicParams {
  /** The cranking signer (our wallet) — pays the tx, may be anyone. */
  authority: PublicKey;
  /** The deployment being settled (seeds the deployment/miner/automation PDAs). */
  deploymentAuthority: PublicKey;
  roundId: number;
  /** Defaults to the cranking signer — rent goes to whoever cranks. */
  rentRecipient?: PublicKey | undefined;
  /**
   * The deployer's affiliate account (`Miner.affiliate`), which receives the
   * affiliate points at settle. Pass nothing when the miner has none (the
   * default pubkey on chain) → program id in the optional slot.
   */
  affiliate?: PublicKey | undefined;
}

export function buildSettleDeployPublic(
  ctx: InstructionContext,
  params: SettleDeployPublicParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, deploymentAuthority, roundId } = params;
  const rentRecipient = params.rentRecipient ?? authority;
  const board = boardPda(programId);
  const miner = minerPda(deploymentAuthority, programId);
  const tokenVault = tokenVaultPda(programId);
  // Not optional accounts: the program derives these addresses so settlement
  // can't dodge automation reload routing; they may be closed/empty on chain.
  const automation = publicAutomationPda(deploymentAuthority, programId);
  const automationUsdAta = getAssociatedTokenAddressSync(ctx.usdMint, automation, true);
  const affiliate =
    params.affiliate && !params.affiliate.equals(PublicKey.default) ? params.affiliate : undefined;

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(roundPda(roundId, programId), true),
      meta(board),
      meta(rentRecipient, true),
      meta(publicDeploymentPda(deploymentAuthority, roundId, programId), true),
      meta(miner, true),
      meta(automation, true),
      meta(automationUsdAta, true),
      meta(getAssociatedTokenAddressSync(ctx.usdMint, miner, true), true),
      affiliate ? meta(affiliate, true) : absent(programId),
      meta(satsVaultPda(programId), true),
      meta(ctx.btcMint),
      meta(ctx.usdMint),
      meta(boardUsdAta(ctx.usdMint, programId), true),
      meta(boardBtcAta(ctx.btcMint, programId), true),
      meta(satsVaultBtcAta(ctx.btcMint, programId), true),
      meta(tokenVault, true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
      // V2 token leg, passed as remaining accounts (SDK buildSettleDeployPublicInstruction).
      meta(ctx.tokenMint),
      meta(getAssociatedTokenAddressSync(ctx.tokenMint, board, true), true),
      meta(getAssociatedTokenAddressSync(ctx.tokenMint, tokenVault, true), true),
    ],
    data: instructionCoder.encode("settle_deploy_public", {}),
  });
}

export interface ClaimSatsParams {
  authority: PublicKey;
  shares: bigint;
}

export function buildClaimSats(
  ctx: InstructionContext,
  params: ClaimSatsParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority } = params;
  const satsVault = satsVaultPda(programId);
  const tokenVault = tokenVaultPda(programId);

  // V2: exiting the sats vault also settles the coupled token-vault leg.
  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(satsVault, true),
      meta(tokenVault, true),
      meta(minerPda(authority, programId), true),
      meta(ctx.btcMint),
      meta(ctx.tokenMint),
      meta(satsVaultBtcAta(ctx.btcMint, programId), true),
      meta(getAssociatedTokenAddressSync(ctx.tokenMint, tokenVault, true), true),
      meta(getAssociatedTokenAddressSync(ctx.btcMint, authority), true),
      meta(getAssociatedTokenAddressSync(ctx.tokenMint, authority), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("claim_sats", {
      shares: toBn(params.shares, "shares"),
    }),
  });
}

export interface ClaimTokenParams {
  authority: PublicKey;
  tokenShares: bigint;
}

/** V2: redeem RUSH token-vault shares (mirror of claim_sats, vaults swapped). */
export function buildClaimToken(
  ctx: InstructionContext,
  params: ClaimTokenParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority } = params;
  const satsVault = satsVaultPda(programId);
  const tokenVault = tokenVaultPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(tokenVault, true),
      meta(satsVault, true),
      meta(minerPda(authority, programId), true),
      meta(ctx.tokenMint),
      meta(ctx.btcMint),
      meta(getAssociatedTokenAddressSync(ctx.tokenMint, tokenVault, true), true),
      meta(satsVaultBtcAta(ctx.btcMint, programId), true),
      meta(getAssociatedTokenAddressSync(ctx.tokenMint, authority), true),
      meta(getAssociatedTokenAddressSync(ctx.btcMint, authority), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("claim_token", {
      token_shares: toBn(params.tokenShares, "token_shares"),
    }),
  });
}

export interface ClaimUsdParams {
  authority: PublicKey;
  amount: bigint;
}

export function buildClaimUsd(
  ctx: InstructionContext,
  params: ClaimUsdParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority } = params;

  // claim_usd emits no event — the IDL lists no event_authority/program here.
  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(boardPda(programId)),
      meta(minerPda(authority, programId), true),
      meta(ctx.usdMint),
      meta(boardUsdAta(ctx.usdMint, programId), true),
      meta(getAssociatedTokenAddressSync(ctx.usdMint, authority), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: instructionCoder.encode("claim_usd", {
      amount: toBn(params.amount, "amount"),
    }),
  });
}

// ── hashrate-funded raffle vaults ───────────────────────────────────────────
// Tickets are bought with hashrate (1 hashrate point per ticket, per the IDL:
// no price constant, InsufficientHashrate bounds tickets_to_buy by the miner's
// balance). Iteration ids are read from the decoded vault account, never
// assumed. Buying a 1-BTC ticket inits a fresh `ticket` account (a keypair the
// caller generates and must add as a signer).

export interface BuyOneBtcTicketsParams {
  authority: PublicKey;
  /** one_btc_vault.iteration_id (from the decoded vault). */
  iterationId: number;
  /** Fresh keypair pubkey for the ticket account; must sign the tx. */
  ticket: PublicKey;
  ticketsToBuy: bigint;
}

export function buildBuyOneBtcTickets(
  ctx: InstructionContext,
  params: BuyOneBtcTicketsParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, iterationId, ticket } = params;

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(minerPda(authority, programId), true),
      meta(oneBtcVaultPda(programId)),
      meta(oneBtcVaultIterationPda(iterationId, programId), true),
      meta(ticket, true, true),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("buy_one_btc_tickets", {
      tickets_to_buy: toBn(params.ticketsToBuy, "tickets_to_buy"),
    }),
  });
}

export interface BuyEpochTicketsParams {
  authority: PublicKey;
  /** epoch_vault.iteration_id (from the decoded vault). */
  iterationId: number;
  pageIndex: number;
  ticketsToBuy: bigint;
}

export function buildBuyEpochTickets(
  ctx: InstructionContext,
  params: BuyEpochTicketsParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, iterationId, pageIndex } = params;

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(minerPda(authority, programId), true),
      meta(satrushConfigPda(programId)),
      meta(epochVaultPda(programId)),
      meta(epochVaultIterationPda(iterationId, programId), true),
      meta(epochVaultPagePda(iterationId, pageIndex, programId), true),
      meta(epochVaultEntryPda(iterationId, authority, programId), true),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("buy_epoch_tickets", {
      tickets_to_buy: toBn(params.ticketsToBuy, "tickets_to_buy"),
      page_index: pageIndex,
    }),
  });
}

export interface TriggerOneBtcDrawParams {
  authority: PublicKey;
  /** Current one_btc_vault.iteration_id. */
  iterationId: number;
}

export function buildTriggerOneBtcDraw(
  ctx: InstructionContext,
  params: TriggerOneBtcDrawParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, iterationId } = params;

  // V2: no slot-hashes/event accounts in the IDL list; the trigger arms the
  // btc rotor by CPI, so the rotor set rides as remaining accounts.
  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(oneBtcVaultPda(programId), true),
      meta(oneBtcVaultIterationPda(iterationId, programId), true),
      meta(oneBtcVaultIterationPda(iterationId + 1, programId), true),
      meta(SystemProgram.programId),
      ...rngRemainingAccounts(ROTOR_TAGS.btc),
    ],
    data: instructionCoder.encode("trigger_one_btc_draw", {}),
  });
}

export interface TriggerEpochDrawParams {
  authority: PublicKey;
  /** Current epoch_vault.iteration_id. */
  iterationId: number;
}

export function buildTriggerEpochDraw(
  ctx: InstructionContext,
  params: TriggerEpochDrawParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, iterationId } = params;

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(epochVaultPda(programId), true),
      meta(epochVaultIterationPda(iterationId, programId), true),
      meta(epochVaultIterationPda(iterationId + 1, programId), true),
      meta(SystemProgram.programId),
      meta(eventAuthorityPda(programId)),
      meta(programId),
      // V2: arms the epoch rotor by CPI.
      ...rngRemainingAccounts(ROTOR_TAGS.epoch),
    ],
    data: instructionCoder.encode("trigger_epoch_draw", {}),
  });
}

export interface SelectEpochWinnerParams {
  authority: PublicKey;
  /** Iteration being settled. */
  iterationId: number;
  /** Page holding the current winning ticket. */
  pageIndex: number;
}

export function buildSelectEpochWinner(
  ctx: InstructionContext,
  params: SelectEpochWinnerParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, iterationId, pageIndex } = params;

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, false, true),
      meta(satrushConfigPda(programId)),
      meta(epochVaultPda(programId), true),
      meta(epochVaultIterationPda(iterationId, programId), true),
      meta(epochVaultPagePda(iterationId, pageIndex, programId)),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("select_epoch_winner", {
      page_index: pageIndex,
    }),
  });
}

export interface ClaimOneBtcRewardParams {
  /** Cranking signer — anyone; the prize goes to the ticket's owner. */
  authority: PublicKey;
  /** Iteration whose prize is being claimed. */
  iterationId: number;
  /** The winning ticket account (kept from the buy). */
  ticket: PublicKey;
  /** The ticket's owner (prize recipient). Defaults to `authority`. */
  winner?: PublicKey | undefined;
}

export function buildClaimOneBtcReward(
  ctx: InstructionContext,
  params: ClaimOneBtcRewardParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, iterationId, ticket } = params;
  const winner = params.winner ?? authority;
  const vault = oneBtcVaultPda(programId);

  // claim_one_btc_reward emits no event — no event_authority/program.
  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(vault, true),
      meta(oneBtcVaultIterationPda(iterationId, programId), true),
      meta(ticket),
      meta(winner),
      meta(ctx.btcMint),
      meta(getAssociatedTokenAddressSync(ctx.btcMint, vault, true), true),
      meta(getAssociatedTokenAddressSync(ctx.btcMint, winner), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: instructionCoder.encode("claim_one_btc_reward", {}),
  });
}

export interface DistributeEpochRewardParams {
  /** Cranker (any signer). Pays nothing; V2 rewards land on the winner's Miner. */
  authority: PublicKey;
  /** Iteration whose reward is being distributed. */
  iterationId: number;
  /** Winner slot in `EpochVaultIteration.winners` (0..20). */
  rank: number;
  /** Authority recorded at `winners[rank]` — its Miner PDA receives the reward. */
  winnerAuthority: PublicKey;
}

/**
 * V2 replaced the winner-signed `claim_epoch_reward` with a permissionless
 * `distribute_epoch_reward(rank)`: USD is moved to the board pool and credited
 * to the winner's Miner (`claim_usd` later), BTC is deposited into the Sats
 * Vault for shares, and the token leg into the token vault. The winner's
 * wallet ATAs are not touched, so callers must not measure the payout there.
 */
export function buildDistributeEpochReward(
  ctx: InstructionContext,
  params: DistributeEpochRewardParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, iterationId, rank, winnerAuthority } = params;
  if (!Number.isInteger(rank) || rank < 0 || rank > 0xff) {
    throw new RangeError(`rank must be a u8, got ${rank}`);
  }
  const vault = epochVaultPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, false, true),
      meta(satrushConfigPda(programId)),
      meta(vault, true),
      meta(epochVaultIterationPda(iterationId, programId), true),
      meta(minerPda(winnerAuthority, programId), true),
      meta(boardPda(programId)),
      meta(satsVaultPda(programId), true),
      meta(ctx.usdMint),
      meta(ctx.btcMint),
      meta(getAssociatedTokenAddressSync(ctx.usdMint, vault, true), true),
      meta(getAssociatedTokenAddressSync(ctx.btcMint, vault, true), true),
      meta(boardUsdAta(ctx.usdMint, programId), true),
      meta(satsVaultBtcAta(ctx.btcMint, programId), true),
      meta(tokenVaultPda(programId), true),
      meta(TOKEN_PROGRAM_ID),
      meta(eventAuthorityPda(programId)),
      meta(programId),
    ],
    data: instructionCoder.encode("distribute_epoch_reward", { rank }),
  });
}

export interface ExchangeAffiliatePointsParams {
  /** The affiliate's authority (only it may exchange). */
  authority: PublicKey;
  /** Points to convert (Affiliate.point_amount units). */
  pointsAmount: bigint;
}

/**
 * V2: convert accrued affiliate points into grubstake USD on the affiliate's
 * own Miner (paid from the treasury into the Miner PDA's USD ATA, so the
 * credit stays program-controlled). The Miner is created if absent.
 */
export interface SetMinerTagParams {
  authority: PublicKey;
  /** 3–16 chars of a-z, 0-9, '_' or '-' (program `Affiliate::validate_tag`). */
  tag: string;
}

/**
 * `set_miner_tag`: claim `tag` for `authority`, creating the wallet's Affiliate
 * PDA (once per wallet) and the tag registry entry (once per tag). Accounts
 * from the IDL: authority (signer, writable), affiliate (writable),
 * affiliate_tag (writable), system_program. No event.
 */
export function buildSetMinerTag(ctx: InstructionContext, params: SetMinerTagParams): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority, tag } = params;
  if (!/^[a-z0-9_-]{3,16}$/.test(tag)) {
    throw new RangeError(`invalid affiliate tag "${tag}": 3–16 chars of a-z, 0-9, '_' or '-'`);
  }
  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(affiliatePda(authority, programId), true),
      meta(affiliateTagPda(tag, programId), true),
      meta(SystemProgram.programId),
    ],
    data: instructionCoder.encode("set_miner_tag", { tag }),
  });
}

export function buildExchangeAffiliatePoints(
  ctx: InstructionContext,
  params: ExchangeAffiliatePointsParams,
): TransactionInstruction {
  const programId = ctx.programId ?? PROGRAM_ID;
  const { authority } = params;
  const miner = minerPda(authority, programId);
  const treasury = treasuryPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, true),
      meta(satrushConfigPda(programId)),
      meta(affiliatePda(authority, programId), true),
      meta(miner, true),
      meta(treasury, true),
      meta(ctx.usdMint),
      meta(getAssociatedTokenAddressSync(ctx.usdMint, treasury, true), true),
      meta(getAssociatedTokenAddressSync(ctx.usdMint, miner, true), true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: instructionCoder.encode("exchange_affiliate_points", {
      points_amount: toBn(params.pointsAmount, "points_amount"),
    }),
  });
}

