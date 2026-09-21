/**
 * Fakes for the orchestrator harness: an RPC connection backed by a map of
 * accounts and balances, and an ingest source the test drives by hand.
 */
import { EventEmitter } from "node:events";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { IngestSource } from "../../src/ingest/types.js";

export class FakeConnection {
  slot = 1_000;
  readonly accounts = new Map<string, { data: Buffer; owner: PublicKey }>();
  readonly lamports = new Map<string, number>();
  readonly usdc = new Map<string, bigint>();
  blockhashCalls = 0;
  readonly rpcEndpoint = "http://fake";
  readonly commitment = "processed" as const;

  constructor(private readonly programId: PublicKey) {}

  setAccount(pubkey: PublicKey, data: Buffer, owner: PublicKey = this.programId): void {
    this.accounts.set(pubkey.toBase58(), { data, owner });
  }

  async getSlot(): Promise<number> {
    return this.slot;
  }
  async getBalance(pk: PublicKey): Promise<number> {
    return this.lamports.get(pk.toBase58()) ?? 0;
  }
  async getTokenAccountBalance(ata: PublicKey): Promise<{ value: { amount: string } }> {
    const v = this.usdc.get(ata.toBase58());
    if (v === undefined) throw new Error("failed to get token account balance: Invalid param: could not find account");
    return { value: { amount: v.toString() } };
  }
  async getAccountInfo(pk: PublicKey) {
    const a = this.accounts.get(pk.toBase58());
    return a ? { data: a.data, owner: a.owner, lamports: 1_000_000, executable: false, rentEpoch: 0 } : null;
  }
  async getMultipleAccountsInfo(keys: PublicKey[]) {
    return Promise.all(keys.map((k) => this.getAccountInfo(k)));
  }
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    this.blockhashCalls++;
    return { blockhash: bs58.encode(Keypair.generate().publicKey.toBytes()), lastValidBlockHeight: this.slot + 150 };
  }
  async getProgramAccounts(): Promise<never[]> {
    return [];
  }
  async getRecentPrioritizationFees(): Promise<{ slot: number; prioritizationFee: number }[]> {
    return [{ slot: this.slot, prioritizationFee: 1_000 }];
  }
  async getSignatureStatuses(): Promise<{ value: null[] }> {
    return { value: [null] };
  }
  async sendRawTransaction(): Promise<never> {
    throw new Error("harness: sendRawTransaction must never be reached in dry mode");
  }
  async simulateTransaction(): Promise<never> {
    throw new Error("harness: simulateTransaction not expected");
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

/** An ingest source the test drives: no network, no timers. */
export class FakeSource extends IngestSource {
  constructor(stalenessMs = 1_500) {
    super(stalenessMs);
  }
  async start(): Promise<void> {
    this.emit("status", { connected: true, detail: "fake" });
  }
  async stop(): Promise<void> {}

  slot(slot: number): void {
    this.markSeen("slots");
    this.emit("slot", { slot });
  }
  account(pubkey: PublicKey, data: Buffer, slot: number, owner: PublicKey, stream: "accounts" | "wallet" = "accounts"): void {
    this.markSeen(stream);
    this.emit("account", { pubkey, owner, data, slot, stream });
  }
  disconnect(detail = "fake drop"): void {
    this.emit("status", { connected: false, detail });
  }
  reconnect(): void {
    this.emit("status", { connected: true, detail: "fake reconnect" });
  }
}

export { EventEmitter };
