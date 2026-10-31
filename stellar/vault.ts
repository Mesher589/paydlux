// Paydlux on Stellar — the vault.
//
// No smart contract. The whole product is three native Stellar primitives:
//
//   1. an issued asset            -> the payment token
//   2. a multisig account         -> the vault (release needs 2 of the signers)
//   3. a pre-authenticated tx     -> the spending mandate, as a hash-signer
//
// The mandate is the interesting one. We pre-build a transaction whose
// operations are EXACTLY "pay N tokens to this payee, inside this time window,
// once", take its hash, and register that hash as a weight-1 signer on the
// vault. The agent is also weight-1, threshold is 2. So the agent can reach
// threshold only by presenting that exact transaction. It cannot change the
// amount, the payee, the window, or run it twice — the ledger says no.
//
// Verified on testnet by stellar/probe-envelope.ts before this file existed.
import {
  Account, Asset, Horizon, Keypair, Memo, Networks, Operation, StrKey,
  Transaction, TransactionBuilder,
} from "@stellar/stellar-sdk";

export type Network = "testnet" | "public";

/** stellar-sdk v17 hands back Uint8Array where v13 gave Buffer. One helper, one shape. */
export function hex(b: Uint8Array | string): string {
  return typeof b === "string" ? b : Buffer.from(b).toString("hex");
}

/**
 * Circle's own USDC issuer on Stellar. Not a wrapped token, not a bridge:
 * native, and Circle is the issuer. Anyone can put "USDC" on a token name —
 * only these two accounts are real money. Never accept any other issuer.
 */
export const USDC_ISSUER: Record<Network, string> = {
  public: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

/** A rejected Stellar transaction, with the ledger's own reason code. */
export class StellarTxError extends Error {
  constructor(public code: string, cause?: unknown) {
    super(`stellar tx rejected: ${code}`);
    this.name = "StellarTxError";
    (this as any).cause = cause;
  }
}

const HORIZON_URL: Record<Network, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};
const PASSPHRASE: Record<Network, string> = {
  testnet: Networks.TESTNET,
  public: Networks.PUBLIC,
};
const FRIENDBOT = "https://friendbot.stellar.org";

/** The network passphrase for a network name (needed to hash transactions). */
export function passphrase(network: Network) { return PASSPHRASE[network]; }

/** Stellar amounts are strings with at most 7 decimals. */
export type Amount = string;

export type MandateSpec = {
  payee: string;
  amount: Amount;
  /** seconds from now the mandate may first execute */
  notBefore?: number;
  /** seconds from now after which it can no longer execute */
  ttl?: number;
  /** memo attached to the payment, so the seller can match it to an order */
  memo?: string;
};

export type Mandate = {
  /** hex hash; also the signer that authorises the payment */
  hash: string;
  /** the built, unsigned transaction — hand this to the agent */
  envelope: string; // base64 xdr
  spec: MandateSpec;
  /** sequence number this envelope must be submitted at */
  sequence: string;
  expiresAt: number;
};

export type VaultSigners = {
  /** the human who owns the money */
  principal: string;
  /** the human approval key (phone / browser wallet) */
  approver: string;
  /** the agent key, handed to the software doing the buying */
  agent: string;
};

export class StellarVault {
  readonly horizon: Horizon.Server;
  readonly network: Network;
  readonly address: string;
 token: Asset;
  signers: VaultSigners;

  private constructor(address: string, token: Asset, signers: VaultSigners, network: Network) {
    this.address = address;
    this.token = token;
    this.signers = signers;
    this.network = network;
    this.horizon = new Horizon.Server(HORIZON_URL[network]);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Fund a key on testnet. No captcha, no phone, no faucet hunt. */
  static async fundTestnet(kp: Keypair) {
    const r = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(kp.publicKey())}`);
    if (!r.ok) throw new Error(`friendbot failed: ${r.status} ${await r.text()}`);
    return kp.publicKey();
  }

  /**
   * Create a vault. `issuer` signs the token; the vault account itself is a
   * multisig whose release threshold needs principal + approver, or agent +
   * a pre-authorised mandate hash. Nothing else reaches threshold.
   */
  static async create(opts: {
    network: Network;
    issuer: Keypair;
    principal: Keypair;
    approver: Keypair;
    agent: Keypair;
    tokenCode: string;
    vaultSeed?: string;
    startingBalance?: string;
  }): Promise<StellarVault> {
    const { network, issuer, principal, approver, agent } = opts;
    const vault = opts.vaultSeed ? Keypair.fromSecret(opts.vaultSeed) : Keypair.random();
    const h = new Horizon.Server(HORIZON_URL[network]);
    const pass = PASSPHRASE[network];

    // 1. the vault account itself
    await sub(h, pass, (await tb(h, issuer.publicKey(), undefined, pass))
      .addOperation(Operation.createAccount({
        destination: vault.publicKey(),
        startingBalance: opts.startingBalance ?? "10",
      })).setTimeout(300).build(), issuer);

    // 2. signers + thresholds, in one atomic tx.
    //    master weight 0: the vault's own seed can never act alone again.
    // The trustline has to ride in this same transaction: once masterWeight is
    // 0 the vault seed cannot sign anything on its own, so a later changeTrust
    // would need two human signatures before the vault can even hold tokens.
    const token = new Asset(opts.tokenCode, issuer.publicKey());
    await sub(h, pass, (await tb(h, vault.publicKey(), undefined, pass))
      .addOperation(Operation.changeTrust({ asset: token, limit: "100000000" }))
      .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: principal.publicKey(), weight: 1 } }))
      .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: approver.publicKey(), weight: 1 } }))
      .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: agent.publicKey(), weight: 1 } }))
      .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 }))
      .setTimeout(300).build(), vault);

    return new StellarVault(vault.publicKey(), token, {
      principal: principal.publicKey(), approver: approver.publicKey(), agent: agent.publicKey(),
    }, network);
  }

  /**
   * A vault that settles in real Circle USDC instead of a test token.
   * Circle mints USDC, so there is no issuer key for us to hold: the vault
   * just needs a trustline, and money arrives from an exchange or Circle's
   * faucet on testnet. Everything else (mandates, thresholds, replay) is the
   * same code.
   */
  static usdcToken(network: Network) { return new Asset("USDC", USDC_ISSUER[network]); }

  /** Add a USDC trustline to an existing vault (needs both human keys). */
  async trustUsdc(principal: Keypair, approver: Keypair, limit = "1000000") {
    return sub(this.horizon, PASSPHRASE[this.network], (await this.tb(this.address))
      .addOperation(Operation.changeTrust({ asset: StellarVault.usdcToken(this.network), limit }))
      .setTimeout(300).build(), principal, approver);
  }

  /** Point this vault at USDC instead of a custom token. */
  useUsdc() { this.token = StellarVault.usdcToken(this.network); return this; }

  /** Re-attach to an existing vault by account id. */
  static async load(address: string, tokenCode: string, issuer: string, signers: VaultSigners, network: Network) {
    const h = new Horizon.Server(HORIZON_URL[network]);
    const acc = await h.loadAccount(address);
    const found = acc.signers ?? [];
    if (!found.some((s) => s.key === signers.principal)) {
      throw new Error(`${address} is not a Paydlux vault (principal ${signers.principal} is not a signer)`);
    }
    return new StellarVault(address, new Asset(tokenCode, issuer), signers, network);
  }

  // ------------------------------------------------------------------ money

  /** The seller must opt in to holding our token before we can pay them. */
  async trustToken(seller: string, limit = "100000000", sellerKeypair: Keypair) {
    await sub(this.horizon, PASSPHRASE[this.network], (await this.tb(seller))
      .addOperation(Operation.changeTrust({ asset: this.token, limit }))
      .setTimeout(300).build(), sellerKeypair);
  }

  /** Move tokens into the vault. Only the vault's signers can move them out. */
  async deposit(amount: Amount, from: Keypair) {
    await sub(this.horizon, PASSPHRASE[this.network], (await this.tb(from.publicKey()))
      .addOperation(Operation.payment({ destination: this.address, asset: this.token, amount }))
      .setTimeout(300).build(), from);
    return this.balance();
  }

  /**
   * Has this transaction already been applied? Horizon de-duplicates an
   * identical resubmission and returns the original result, so "submit
   * succeeded" does NOT mean "money moved just now". Sellers must check.
   */
  async txExists(hash: string): Promise<boolean> {
    const r = await fetch(`${HORIZON_URL[this.network]}/transactions/${hash}`).catch(() => null);
    return !!r && r.ok;
  }

  async balance(account = this.address): Promise<Amount> {
    const acc = await this.horizon.loadAccount(account);
    const b = acc.balances.find(
      (x: any) => x.asset_type !== "native" && x.asset_type !== "liquidity_pool_shares"
        && x.asset_code === this.token.getCode() && x.asset_issuer === this.token.getIssuer(),
    ) as any;
    return b?.balance ?? "0";
  }

  // --------------------------------------------------------------- mandates

  /**
   * Build a mandate and register it on the vault.
   *
   * Returns the envelope (base64 XDR) to hand to the agent plus its hash. The
   * agent submits it with its own signature; the pre-auth signer supplies the
   * second. The agent cannot alter it: any edit changes the hash, and the hash
   * is the signer.
   */
  async createMandate(spec: MandateSpec, principal: Keypair, approver: Keypair): Promise<Mandate> {
    if (spec.payee === this.address) throw new Error("payee cannot be the vault");
    if (!(Number(spec.amount) > 0)) throw new Error("amount must be positive");

    const acc = await this.horizon.loadAccount(this.address);
    const now = Math.floor(Date.now() / 1000);
    const notBefore = now + (spec.notBefore ?? -60);
    const expiresAt = now + (spec.ttl ?? 3600);

    // The setOptions below takes sequence S+1, so the envelope must claim S+2.
    const eb = (await this.tbAt(this.address, BigInt(acc.sequence) + 1n))
      .addOperation(Operation.payment({
        destination: spec.payee, asset: this.token, amount: spec.amount,
      }))
      .setTimebounds(notBefore, expiresAt);
    if (spec.memo) eb.addMemo(Memo.text(spec.memo));
    const envelope = eb.build();
    const hash = hex(envelope.hash());

    // register the hash as a weight-1 signer. Two signatures now exist that
    // reach threshold 2: (agent + this hash) and (principal + approver).
    // setOptions needs med threshold 2, so registering a mandate always takes
    // both human keys. The agent can never write its own spending rules.
    //
    // A pre-auth transaction is bound to a sequence number, so exactly ONE
    // mandate can be live: the newest. Any older one is already in the past and
    // can never run again. We revoke the old ones in the same transaction so
    // the state is never ambiguous — one open order at a time, on purpose.
    const b = await this.tb(this.address);
    for (const s of (acc.signers ?? []).filter((s) => s.key.startsWith("T") && s.weight > 0)) {
      b.addOperation(Operation.setOptions({ signer: { preAuthTx: StrKey.decodePreAuthTx(s.key), weight: 0 } }));
    }
    b.addOperation(Operation.setOptions({ signer: { preAuthTx: hash, weight: 1 } }));
    await sub(this.horizon, PASSPHRASE[this.network], b.setTimeout(expiresAt - now + 60).build(), principal, approver);

    return { hash, envelope: envelope.toXDR(), spec, sequence: (BigInt(acc.sequence) + 2n).toString(), expiresAt };
  }

  /** The agent's side: sign the envelope and submit. That is all it can do. */
  async executeMandate(mandate: Mandate, agentKeypair: Keypair) {
    const tx = new Transaction(mandate.envelope, PASSPHRASE[this.network]);
    tx.sign(agentKeypair);
    return sub(this.horizon, PASSPHRASE[this.network], tx);
  }

  /**
   * The human path: approve a payment directly. Needs principal + approver,
   * so a stolen agent key cannot use it and a stolen phone cannot use it alone.
   */
  async release(payee: string, amount: Amount, principal: Keypair, approver: Keypair, memo?: string) {
    const b = (await this.tb(this.address))
      .addOperation(Operation.payment({ destination: payee, asset: this.token, amount }))
      .setTimeout(300);
    if (memo) b.addMemo(Memo.text(memo));
    return sub(this.horizon, PASSPHRASE[this.network], b.build(), principal, approver);
  }

  /**
   * Kill every outstanding mandate at once. Any accepted transaction bumps the
   * vault's sequence, which invalidates all pre-authorized hashes pointing at a
   * later sequence. This is the panic button: it needs principal + approver,
   * so a stolen agent key cannot pull it and a stolen phone cannot pull it alone.
   */
  async revokeAll(principal: Keypair, approver: Keypair) {
    const acc = await this.horizon.loadAccount(this.address);
    const outstanding = (acc.signers ?? []).filter((s) => s.key.startsWith("T") && s.weight > 0);
    if (!outstanding.length) return null;
    const b = await this.tb(this.address);
    for (const s of outstanding) {
      // Horizon returns the preauth signer as a strkey "T…" — decode it back to
      // the raw 32-byte hash the SDK expects.
      b.addOperation(Operation.setOptions({ signer: { preAuthTx: StrKey.decodePreAuthTx(s.key), weight: 0 } }));
    }
    const res = await sub(this.horizon, PASSPHRASE[this.network], b.setTimeout(300).build(), principal, approver);
    return { revoked: outstanding.length, tx: res?.hash };
  }

  /** Rotate the agent key: a compromised agent is replaced, mandates die with it. */
  async rotateAgent(oldAgent: Keypair, newAgentPub: string, human: Keypair) {
    return sub(this.horizon, PASSPHRASE[this.network], (await this.tb(this.address))
      .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: oldAgent.publicKey(), weight: 0 } }))
      .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: newAgentPub, weight: 1 } }))
      .setTimeout(300).build(), human, oldAgent);
  }

  /** Who can sign for this vault right now. */
  async signerSummary() {
    const acc: any = await this.horizon.loadAccount(this.address);
    const t = acc.thresholds ?? {};
    return {
      thresholds: {
        low: t.low_threshold ?? t.lowThreshold,
        med: t.med_threshold ?? t.medThreshold,
        high: t.high_threshold ?? t.highThreshold,
      },
      signers: (acc.signers ?? []).map((s: any) => ({
        key: s.key, weight: s.weight,
        type: s.key.startsWith("T") ? "preauth-mandate" : s.weight === 0 ? "disabled-master" : "key",
      })),
    };
  }

  // ---------------------------------------------------------------- plumbing

  private async tb(pub: string) {
    return tb(this.horizon, pub, undefined, PASSPHRASE[this.network]);
  }
  private async tbAt(pub: string, at: bigint) {
    return tb(this.horizon, pub, at, PASSPHRASE[this.network]);
  }
}

async function tb(h: Horizon.Server, pub: string, afterSeq: bigint | undefined, pass: string) {
  const acc = afterSeq === undefined
    ? await h.loadAccount(pub)
    : new Account(pub, afterSeq.toString());
  return new TransactionBuilder(acc, { fee: (await h.fetchBaseFee()).toString(), networkPassphrase: pass });
}

async function sub(h: Horizon.Server, _pass: string, tx: Transaction, ...signers: Keypair[]) {
  if (signers.length) tx.sign(...signers);
  try {
    return await h.submitTransaction(tx);
  } catch (e: any) {
    // stellar-sdk throws BadResponse with the result codes attached; older
    // shapes put them under response.data.extras. Try both, then the xdr.
    let codes: string[] | undefined;
    try { codes = e?.resultResultCodes?.()?.results; } catch { /* shape differs */ }
    codes ??= e?.response?.data?.extras?.result_codes?.results;
    const detail = codes?.join(",") || e?.response?.data?.extras?.result_xdr || e?.message || String(e);
    throw new StellarTxError(detail, e);
  }
}

export { Keypair, Asset, Networks };
