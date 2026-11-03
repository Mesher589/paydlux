// Prove a Stellar address is real WITHOUT trusting the SDK: decode base32,
// recompute CRC16-XMODEM, compare. 56 chars = 280 bits = 35 bytes
// (1 version nibble-packed with 3 bits, 32-byte ed25519 key, 2-byte CRC).
//
// Why hand-roll this when the SDK exists: the SDK throws on a bad address and
// says nothing about *why*. When a wallet or an exchange rejects an address,
// the useful answer is "the checksum does not match" or "the account does not
// exist on this network yet" — two completely different problems that both come
// out of a UI as "invalid address". This module separates them.
import { Keypair, Networks } from "@stellar/stellar-sdk";

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HORIZON: Record<string, string> = {
  public: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

export type AddressVerdict = {
  address: string;
  bytes: number;
  version: number;
  checksumOk: boolean;
  crcInAddress: string;
  crcComputed: string;
  exists: boolean;
  balance?: string;
  error?: string;
};

/** CRC16-XMODEM as stellar-base computes it. */
function crc16(bytes: number[]): number {
  let c = 0;
  for (const x of bytes) {
    c ^= x << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

const hex = (n: number[]) => n.map((x) => x.toString(16).padStart(2, "0")).join(" ");

export function decodeAddress(address: string): Omit<AddressVerdict, "exists" | "balance"> {
  let bits = 0, val = 0;
  const b: number[] = [];
  for (const ch of address) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) return { address, bytes: -1, version: -1, checksumOk: false,
      crcInAddress: "", crcComputed: "", error: `not base32: "${ch}"` };
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { bits -= 8; b.push((val >> bits) & 0xff); }
  }
  if (b.length !== 35) return { address, bytes: b.length, version: -1, checksumOk: false,
    crcInAddress: "", crcComputed: "", error: `decoded to ${b.length} bytes, expected 35` };
  const version = b[0] >> 3;
  const crc = b.slice(33, 35);
  const c = crc16(b.slice(0, 33));
  // Stellar writes the CRC16 little-endian (stellar-base: writeUInt16LE), so the
  // address carries [low, high]. Comparing big-endian reads a valid address as
  // corrupt — which is exactly the kind of false alarm that makes a person send
  // money somewhere else.
  const le = [c & 0xff, (c >> 8) & 0xff];
  return {
    address, bytes: b.length, version,
    checksumOk: version === 6 && crc[0] === le[0] && crc[1] === le[1],
    crcInAddress: hex(crc), crcComputed: hex(le),
  };
}

/** Decode the checksum, then ask the ledger whether the account exists. */
export async function checkStellarAddress(address: string, network: "public" | "testnet" = "public"): Promise<AddressVerdict> {
  const base = decodeAddress(address);
  if (!base.checksumOk) return { ...base, exists: false };
  const res = await fetch(`${HORIZON[network]}/accounts/${address}`);
  if (res.status === 404) return { ...base, exists: false };
  if (!res.ok) return { ...base, exists: false, error: `horizon said ${res.status}` };
  const j: any = await res.json();
  const native = (j.balances ?? []).find((x: any) => x.asset_type === "native");
  return { ...base, exists: true, balance: native?.balance };
}

/** Does `seed` derive `address`? Used to prove a file's key and its address agree. */
export function seedDerives(seed: string, address: string): boolean {
  try { return Keypair.fromSecret(seed).publicKey() === address; } catch { return false; }
}

export { Networks };
