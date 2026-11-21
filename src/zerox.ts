// buy-stake's quotes come from 0x's keyless gateway, which sells each request for 0.01 USDC on Base over x402 and needs
// no API key. The worker pays from its own key. A refused request is still charged, so the payment is held to that
// one price, asset and chain before it is signed, and nothing else is ever paid for.

import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ACCEPT_SIGNATURE, type SignedResponse } from "brainchain-verify/zerox";
import { formatUnits, type LocalAccount } from "viem";

import { reason } from "./chain.js";
import type { Network } from "./network.js";

export interface PaidQuote {
  /** The URL as requested, which the signature's query is held to. */
  url: string;
  response: SignedResponse;
  /** The payment's transaction on Base, as the gateway reports it. */
  payment?: string;
}

export type Quoter = (query: Record<string, string>) => Promise<PaidQuote>;

/** Far above a quote, which is about 13 KB with its calldata. */
const BODY_LIMIT = 1 << 20;
const REQUEST_MS = 30_000;

/** A quote that was not paid for: the gateway asked for something else, or the payment could not be made. */
export class NotPaid extends Error {}

export function createQuoter(zerox: NonNullable<Network["zerox"]>, account: LocalAccount, fetchImpl: typeof fetch = fetch): Quoter {
  const { payment } = zerox;
  const network = `eip155:${payment.chainId}` as const;
  const usdc = (amount: bigint | string) => `${formatUnits(BigInt(amount), 6)} USDC`;
  return async (query) => {
    let asked: string | undefined;
    let signed = false;
    const client = x402Client.fromConfig({
      schemes: [{ network, client: new ExactEvmScheme(account) }],
      // Only the plain EIP-3009 transfer of USDC on Base, at the one price, behind the library's own 1 USD cap. The
      // gateway also offers a batched option, which locks a deposit for a week.
      policies: [
        (_version, requirements) => {
          const kept = requirements.filter(
            (r) =>
              r.scheme === "exact" &&
              r.network === network &&
              r.asset.toLowerCase() === payment.usdc.toLowerCase() &&
              BigInt(r.amount) <= payment.price &&
              (r.extra as { name?: unknown } | undefined)?.name === "USD Coin",
          );
          if (kept.length === 0) asked = requirements.map((r) => `${r.amount} of ${r.asset} on ${r.network}`).join(", ");
          return kept;
        },
      ],
    });
    client.onAfterPaymentCreation(async () => {
      signed = true;
    });
    const url = `${zerox.quote}?${new URLSearchParams(query)}`;
    // The x402 client sends clones of the request, so each one carries its own deadline.
    const timed: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
    let response: Response;
    try {
      response = await wrapFetchWithPayment(timed, client)(url, { headers: { "Accept-Signature": ACCEPT_SIGNATURE } });
    } catch (error) {
      if (signed) throw new Error(`0x's gateway did not answer after the payment was signed (${reason(error).replace(/\.$/, "")}), so its ${usdc(payment.price)} may be spent. Nothing else was sent.`);
      if (asked) throw new NotPaid(`0x's gateway asks ${asked} for a quote, where buy-stake pays ${usdc(payment.price)} on ${payment.name}. Nothing was paid.`);
      throw new NotPaid(`Could not buy a quote from 0x's gateway: ${reason(error).replace(/\.$/, "")}. Nothing was paid.`);
    }
    if (response.status === 402) throw new NotPaid(`0x's gateway refused the payment (402). Nothing was paid; check the wallet's USDC on ${payment.name}.`);
    const body = await capped(response).catch((error: unknown) => {
      throw new Error(`0x's gateway was paid ${usdc(payment.price)} and its answer could not be read (${reason(error).replace(/\.$/, "")}). Nothing else was sent.`);
    });
    const receipt = response.headers.get("payment-response");
    let paid: string | undefined;
    try {
      paid = receipt ? decodePaymentResponseHeader(receipt).transaction : undefined;
    } catch {
      paid = undefined;
    }
    return { url, response: { status: response.status, headers: response.headers, body }, ...(paid ? { payment: paid } : {}) };
  };
}

async function capped(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > BODY_LIMIT) throw new Error(`0x's answer is larger than ${BODY_LIMIT} bytes`);
    chunks.push(chunk);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}
