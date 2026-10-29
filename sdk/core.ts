// Core protocol layer: EIP-712 typed signing for mandates, payment intents,
// spend sessions and delivery receipts. Mirrors contracts/src/AgentVault.sol
// exactly — any drift breaks signature verification on chain.
import {
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDomain,
  keccak256,
  encodeAbiParameters,
  encodePacked,
  toBytes,
  concat,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const VAULT_NAME = "AgentVault";
export const VAULT_VERSION = "1";

export type Domain = TypedDataDomain & { name: string; version: string; chainId: number; verifyingContract: Address };

export const types = {
  Mandate: [
    { name: "principal", type: "address" },
    { name: "agent", type: "address" },
    { name: "validAfter", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "perCallMax", type: "uint128" },
    { name: "dailyBudget", type: "uint128" },
    { name: "totalBudget", type: "uint128" },
    { name: "payeeRoot", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
  PaymentIntent: [
    { name: "mandateId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint128" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "requestHash", type: "bytes32" },
  ],
  SpendSession: [
    { name: "mandateId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "maxAmount", type: "uint128" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
  SpendClaim: [
    { name: "sessionId", type: "bytes32" },
    { name: "amount", type: "uint128" },
    { name: "nonce", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
  DeliveryReceipt: [
    { name: "paymentId", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
    { name: "deliveredAt", type: "uint64" },
  ],
} as const;

export type Mandate = {
  principal: Address;
  agent: Address;
  validAfter: bigint;
  validUntil: bigint;
  perCallMax: bigint;
  dailyBudget: bigint;
  totalBudget: bigint;
  payeeRoot: Hex;
  nonce: bigint;
};

export type PaymentIntent = {
  mandateId: Hex;
  payee: Address;
  amount: bigint;
  validUntil: bigint;
  nonce: bigint;
  requestHash: Hex;
};

export type SpendSession = { mandateId: Hex; payee: Address; maxAmount: bigint; validUntil: bigint; nonce: bigint };
export type SpendClaim = { sessionId: Hex; amount: bigint; nonce: bigint; validUntil: bigint };
export type DeliveryReceipt = { paymentId: Hex; contentHash: Hex; deliveredAt: bigint };

/** The live HTTP request the payment proof is bound to. */
export type RequestBinding = { method: string; uri: string; bodyHash: Hex; nonce: bigint };

/** keccak256(method || uri || bodyHash || nonce) — must match the contract. */
export function requestHash(b: RequestBinding): Hex {
  return keccak256(encodePacked(["string", "string", "bytes32", "uint256"], [b.method, b.uri, b.bodyHash, b.nonce]));
}

export function bodyHash(body: string | Uint8Array): Hex {
  return keccak256(typeof body === "string" ? toBytes(body) : (body as never));
}

export function emptyHash(): Hex {
  return keccak256(new Uint8Array(0));
}

export function domain(d: Omit<Domain, "name" | "version">): Domain {
  return { name: VAULT_NAME, version: VAULT_VERSION, ...d };
}

export type Signer = { address: Address; signTypedData: (p: { domain: Domain; types: never; message: never }) => Promise<Hex> };

export function signerFromKey(pk: Hex): Signer {
  const a = privateKeyToAccount(pk);
  return { address: a.address, signTypedData: (p) => a.signTypedData(p as never) };
}

/** Sign one of the protocol structures. Returns an EIP-2718-ish compact sig (r||s||v). */
export async function signStructure(
  signer: Signer,
  d: Domain,
  kind: keyof typeof types,
  message: Record<string, unknown>,
): Promise<Hex> {
  const sig = await signer.signTypedData({ domain: d, types: types as never, primaryType: kind, message: message as never });
  return sig;
}

export const MANDATE_TYPEHASH = keccak256(
  stringToBytes(
    "Mandate(address principal,address agent,uint64 validAfter,uint64 validUntil,uint128 perCallMax,uint128 dailyBudget,uint128 totalBudget,bytes32 payeeRoot,uint256 nonce)",
  ),
);

/**
 * The mandate id is its EIP-712 digest (0x1901 || domainSeparator || structHash),
 * exactly as `_mandateDigest` computes it on chain.
 */
export function mandateDigest(d: Domain, m: Mandate): Hex {
  const structHash = keccak256(
    concat([
      MANDATE_TYPEHASH,
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "uint128" },
          { type: "uint128" },
          { type: "uint128" },
          { type: "bytes32" },
          { type: "uint256" },
        ],
        [m.principal, m.agent, m.validAfter, m.validUntil, m.perCallMax, m.dailyBudget, m.totalBudget, m.payeeRoot, m.nonce],
      ),
    ]),
  );
  return keccak256(`0x1901${domainSeparator(d).slice(2)}${structHash.slice(2)}` as Hex);
}

export function domainSeparator(d: Domain): Hex {
  const typeHash = keccak256(
    stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  const body = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [typeHash, keccak256(stringToBytes(d.name)), keccak256(stringToBytes(d.version)), BigInt(d.chainId), d.verifyingContract],
  );
  return keccak256(body);
}
