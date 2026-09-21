/**
 * Funding made scannable: the primary wallet is the fleet's only deposit
 * address, and a Solana Pay URI turns it into a QR any phone wallet reads
 * (Phantom, Solflare, Backpack). Two QRs: USDC (spl-token) and SOL (fees).
 * Nothing here touches a key — addresses only.
 */
import QRCode from "qrcode";

export interface DepositInfo {
  address: string;
  usdcMint: string;
  /** Solana Pay URIs. */
  usdcUri: string;
  solUri: string;
  /** Suggested first deposit for a fleet of `fleetSize` (USDC float + a week of conversion is the operator's call; this is the floor). */
  minUsdc: number;
  minSol: number;
}

export function solanaPayUri(address: string, opts: { splToken?: string | undefined; label?: string | undefined; message?: string | undefined; amount?: number | undefined }): string {
  const q = new URLSearchParams();
  if (opts.amount && opts.amount > 0) q.set("amount", String(opts.amount));
  if (opts.splToken) q.set("spl-token", opts.splToken);
  if (opts.label) q.set("label", opts.label);
  if (opts.message) q.set("message", opts.message);
  const qs = q.toString();
  return `solana:${address}${qs ? "?" + qs : ""}`;
}

export function depositInfo(address: string, usdcMint: string, fleetSize: number): DepositInfo {
  const wallets = Math.max(1, fleetSize);
  return {
    address,
    usdcMint,
    usdcUri: solanaPayUri(address, { splToken: usdcMint, label: "Sat Rush fleet", message: "USDC for the fleet treasury" }),
    solUri: solanaPayUri(address, { label: "Sat Rush fleet", message: "SOL for fees and rent" }),
    // 21 wallets × $20 floor of float, and 0.02 SOL each plus a fee reserve.
    minUsdc: wallets * 20,
    minSol: Number((wallets * 0.02 + 0.3).toFixed(2)),
  };
}

export async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", errorCorrectionLevel: "M", margin: 2, scale: 6 });
}

export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 2, scale: 5 });
}

export async function qrAscii(text: string): Promise<string> {
  return QRCode.toString(text, { type: "terminal", small: true, errorCorrectionLevel: "M" });
}
