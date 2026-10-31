// Public API of the Paydlux agent-payment SDK.
//
//   import { StellarVault, Gateway, PaydluxAgent, ApprovalDesk } from "@paydlux/agent";
export { StellarVault, StellarTxError, passphrase, USDC_ISSUER } from "./vault.ts";
export type { Network, Amount, Mandate, MandateSpec, VaultSigners } from "./vault.ts";
export { Gateway } from "./gateway.ts";
export type { GatewayConfig, Route, PaymentProof } from "./gateway.ts";
export { PaydluxAgent } from "./agent.ts";
export type { AgentConfig, PayResponse } from "./agent.ts";
export { ApprovalDesk, newPortalKey } from "./desk.ts";
export type { DeskConfig, DeskRecord } from "./desk.ts";
export { portalPage } from "./portal.ts";
export { PolicyEngine, DEFAULT_POLICY } from "./policy.ts";
export type { Policy, SpendEvent, Verdict } from "./policy.ts";
