import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { MAINNET } from "./network.js";
import { createQuoter, NotPaid } from "./zerox.js";

const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59";

/** The gateway's 402, with the four ways to pay it offered on 2026-11-21. */
function challenge(url: string, amount = "10000") {
  const accepts = [
    { scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "94tKEV2exvhoHwUYTw8fgm2aMD5eXmHHAm6NMwcszFHU", maxTimeoutSeconds: 300, extra: {} },
    { scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 605400, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" } },
  ];
  const required = { x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url, description: "quote", mimeType: "application/json" }, accepts };
  return new Response(JSON.stringify(required), { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(required)).toString("base64"), "content-type": "application/json" } });
}

function gateway(amount?: string) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, headers: request.headers });
    if (!request.headers.get("payment-signature")) return challenge(request.url, amount);
    const receipt = Buffer.from(JSON.stringify({ success: true, transaction: `0x${"9f".repeat(32)}`, network: "eip155:8453", payer: account.address })).toString("base64");
    return new Response('{"mode":"exact-out"}', { status: 200, headers: { "content-type": "application/json", "payment-response": receipt, signature: "sig=:x:" } });
  };
  return { fetcher, seen };
}

describe("createQuoter", () => {
  it("pays the gateway's 0.01 USDC on Base by EIP-3009, to the same URL, and asks for 0x's signature", async () => {
    const { fetcher, seen } = gateway();
    const quote = await createQuoter(MAINNET.zerox!, account, fetcher)({ chainId: "4663", buyAmount: "1" });
    expect(quote.url).toBe("https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote/?chainId=4663&buyAmount=1");
    expect(quote.payment).toBe(`0x${"9f".repeat(32)}`);
    expect(Buffer.from(quote.response.body).toString()).toBe('{"mode":"exact-out"}');
    expect(seen.map((s) => s.url)).toEqual([quote.url, quote.url]);
    expect(seen.every((s) => s.headers.get("accept-signature")?.includes('tag="0x-swap-api"'))).toBe(true);
    const payment = JSON.parse(Buffer.from(seen[1]!.headers.get("payment-signature")!, "base64").toString()) as {
      accepted: { network: string; asset: string; amount: string; extra: { name: string } };
      payload: { authorization: { from: string; to: string; value: string } };
    };
    expect(payment.accepted).toMatchObject({ network: "eip155:8453", asset: USDC, amount: "10000", extra: { name: "USD Coin" } });
    expect(payment.payload.authorization).toMatchObject({ from: account.address, to: PAY_TO, value: "10000" });
  });

  it("buys a price from the gateway's price endpoint, paid the same way", async () => {
    const { fetcher, seen } = gateway();
    const price = await createQuoter(MAINNET.zerox!, account, fetcher)({ chainId: "4663", buyAmount: "1" }, "price");
    expect(price.url).toBe("https://agent.api.0x.org/v1/x402/swap-allowance-holder-price/?chainId=4663&buyAmount=1");
    expect(seen.map((s) => s.url)).toEqual([price.url, price.url]);
    expect(seen[1]!.headers.get("payment-signature")).toBeTruthy();
    const refused = await createQuoter(MAINNET.zerox!, account, gateway("20000").fetcher)({ chainId: "4663" }, "price").catch((e: unknown) => e);
    expect((refused as Error).message).toBe("0x's gateway asks 0.02 USDC on Base for a price, where buy-stake pays 0.01 USDC on Base. Nothing was paid.");
  });

  it("pays nothing when the gateway asks more than 0.01 USDC, and says what it asked", async () => {
    const { fetcher, seen } = gateway("20000");
    const error = await createQuoter(MAINNET.zerox!, account, fetcher)({ chainId: "4663" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotPaid);
    expect((error as Error).message).toBe("0x's gateway asks 0.02 USDC on Base for a quote, where buy-stake pays 0.01 USDC on Base. Nothing was paid.");
    expect(seen.filter((s) => s.headers.get("payment-signature"))).toEqual([]);
  });

  it("says the payment may be spent when the gateway stops answering after it was signed", async () => {
    const { fetcher } = gateway();
    const failing: typeof fetch = async (input, init) => {
      if (new Request(input, init).headers.get("payment-signature")) throw new TypeError("fetch failed");
      return fetcher(input, init);
    };
    await expect(createQuoter(MAINNET.zerox!, account, failing)({ chainId: "4663" })).rejects.toThrow(
      "0x's gateway did not answer after the payment was signed (fetch failed), so its 0.01 USDC may be spent. Nothing else was sent.",
    );
  });
});
