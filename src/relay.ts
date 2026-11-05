// Relay (relay.link) moves value between Solana and Robinhood Chain in about a second. The worker uses it to fund
// itself from Solana and to send its earnings there; every quote is checked against what goes in before anything is
// signed, so a bad price stops the move instead of costing the worker.

import type { Address, Hex } from "viem";

export const RELAY_API = "https://api.relay.link";
export const SOLANA_CHAIN_ID = 792703809;
/** USDC on Solana. */
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const NATIVE = "0x0000000000000000000000000000000000000000";
/** The most a move may cost, as a share of its dollar value; small moves may cost up to FIXED_LOSS_USD instead. */
export const MAX_LOSS = 0.03;
/** Relay's fee is partly fixed (about 0.2 USD), so a small move is allowed to lose up to this much in dollars. */
export const FIXED_LOSS_USD = 0.5;

export interface EvmItem {
  to: Address;
  data: Hex;
  value: string;
  chainId: number;
}

export interface SvmItem {
  instructions: { keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; programId: string; data: string }[];
  addressLookupTableAddresses: string[];
}

export interface RelayQuote {
  requestId: string;
  steps: { id: string; requestId?: string; items: { data: EvmItem | SvmItem }[] }[];
  inUsd: number;
  outUsd: number;
  outAmount: bigint;
  outFormatted: string;
}

export interface QuoteRequest {
  user: string;
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: bigint;
}

export class RelayError extends Error {}

export async function relayQuote(request: QuoteRequest, fetchImpl: typeof fetch = fetch): Promise<RelayQuote> {
  const response = await fetchImpl(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, amount: request.amount.toString(), tradeType: "EXACT_INPUT" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || !body.details || !Array.isArray(body.steps)) {
    throw new RelayError(`Relay has no route for this move right now${body.message ? `: ${body.message}` : ""}`);
  }
  const requestId = body.steps.find((s: { requestId?: string }) => s.requestId)?.requestId;
  if (!requestId) throw new RelayError("Relay's quote carries no request id to follow");
  return {
    requestId,
    steps: body.steps,
    inUsd: Number(body.details.currencyIn?.amountUsd ?? 0),
    outUsd: Number(body.details.currencyOut?.amountUsd ?? 0),
    outAmount: BigInt(body.details.currencyOut?.amount ?? 0),
    outFormatted: String(body.details.currencyOut?.amountFormatted ?? "0"),
  };
}

/** Refuses a quote that loses more than MAX_LOSS of its dollar value, or FIXED_LOSS_USD on a small move. */
export function checkReturn(quote: Pick<RelayQuote, "inUsd" | "outUsd">): void {
  if (!(quote.inUsd > 0)) throw new RelayError("Relay's quote has no dollar value for what goes in, so its price cannot be checked");
  const loss = quote.inUsd - quote.outUsd;
  const allowed = Math.max(quote.inUsd * MAX_LOSS, FIXED_LOSS_USD);
  if (loss > allowed) {
    throw new RelayError(`Relay would keep ${loss.toFixed(2)} USD of ${quote.inUsd.toFixed(2)}, more than the ${allowed.toFixed(2)} this command accepts (3%, or 0.50 USD on a small move). Nothing was sent; try again later.`);
  }
}

export type RelayStatus = "success" | "failure" | "refund" | "pending";

export async function relayStatus(requestId: string, fetchImpl: typeof fetch = fetch): Promise<RelayStatus> {
  const response = await fetchImpl(`${RELAY_API}/intents/status/v2?requestId=${requestId}`, { signal: AbortSignal.timeout(20_000) });
  const body = (await response.json().catch(() => ({}))) as { status?: string };
  if (body.status === "success" || body.status === "failure" || body.status === "refund") return body.status;
  return "pending";
}

/** Follows a move until Relay says it landed, failed or was refunded, for at most `ms`. */
export async function waitForRelay(requestId: string, ms = 600_000, fetchImpl: typeof fetch = fetch, sleep = (t: number) => new Promise((r) => setTimeout(r, t))): Promise<RelayStatus> {
  const end = Date.now() + ms;
  for (;;) {
    const status = await relayStatus(requestId, fetchImpl).catch(() => "pending" as const);
    if (status !== "pending" || Date.now() > end) return status;
    await sleep(3_000);
  }
}
