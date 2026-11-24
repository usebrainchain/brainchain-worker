import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { BASE } from "./base.js";
import { createPermitMover, readPermit, RELAY_APPROVAL_PROXIES, signPermit, type Authorization, type PermitWanted } from "./permit.js";
import { MAX_LOSS, NATIVE, relayQuote, type RelayQuote, type RelayStatus } from "./relay.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OWNER = account.address;
const NOW = 1_795_525_600;
const ID = `0x${"17".repeat(32)}`;
const NONCE = `0x${"ec".repeat(32)}` as Hex;
const PROXY = RELAY_APPROVAL_PROXIES[0]!;
const RH = { chainId: 4663, name: "Robinhood Chain" };

/** A quote as Relay's API answers it for a gasless move of USDC on Base, captured from a real one and made adjustable. */
function body(amount = 5_000_000n, change: (b: any) => void = () => {}) {
  const b: any = {
    steps: [
      {
        id: "authorize1",
        action: "Sign authorization",
        kind: "signature",
        requestId: ID,
        items: [
          {
            status: "incomplete",
            data: {
              sign: {
                signatureKind: "eip712",
                types: {
                  ReceiveWithAuthorization: [
                    { name: "from", type: "address" },
                    { name: "to", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "validAfter", type: "uint256" },
                    { name: "validBefore", type: "uint256" },
                    { name: "nonce", type: "bytes32" },
                  ],
                },
                domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE.token.toLowerCase() },
                primaryType: "ReceiveWithAuthorization",
                value: { from: OWNER, to: PROXY, value: amount.toString(), validAfter: 0, validBefore: NOW + 430, nonce: NONCE },
              },
              post: { endpoint: "/execute/permits", method: "POST", body: { kind: "eip3009", requestId: ID, api: "swap" } },
            },
            check: { endpoint: `/intents/status?requestId=${ID}`, method: "GET" },
          },
        ],
      },
    ],
    details: {
      recipient: OWNER,
      currencyIn: { currency: { chainId: 8453, address: BASE.token.toLowerCase() }, amount: amount.toString(), amountUsd: "5.0" },
      currencyOut: { currency: { chainId: 4663, address: NATIVE }, amount: "2914484061100405", amountFormatted: "0.002914484061100405", amountUsd: "4.957" },
    },
  };
  change(b);
  return b;
}

const answer = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status });
const quoteOf = (b: unknown) =>
  relayQuote({ user: OWNER, recipient: OWNER, originChainId: 8453, destinationChainId: 4663, originCurrency: BASE.token, destinationCurrency: NATIVE, amount: 5_000_000n }, (async () => answer(b)) as unknown as typeof fetch);
const want: PermitWanted = { owner: OWNER, origin: BASE, amount: 5_000_000n, recipient: OWNER, currency: NATIVE, destination: RH, now: NOW };
const sign = (b: any) => b.steps[0].items[0].data.sign;

describe("readPermit", () => {
  it("takes Relay's authorization of exactly this USDC to its approval proxy, and rebuilds what is signed from the checked values", async () => {
    const authorization = readPermit(await quoteOf(body()), want) as Authorization;
    expect(authorization).toEqual({
      requestId: ID,
      api: "swap",
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE.token },
      message: { from: OWNER, to: PROXY, value: 5_000_000n, validAfter: 0n, validBefore: BigInt(NOW + 430), nonce: NONCE },
    });
  });

  it("refuses any other signature, token, payer, payee or amount", async () => {
    const cases: [(b: any) => void, string][] = [
      [(b) => b.steps.push(b.steps[0]), "it is not one signature"],
      [(b) => (b.steps[0].kind = "transaction"), "it is not one signature"],
      // An EIP-2612 permit would leave an allowance standing; only the one-off authorization is signed.
      [(b) => (sign(b).primaryType = "Permit"), "it asks for a signature other than a token authorization"],
      [(b) => (sign(b).signatureKind = "eip191"), "it asks for a signature other than a token authorization"],
      [(b) => sign(b).types.ReceiveWithAuthorization.push({ name: "extra", type: "bytes" }), "its authorization has fields a token authorization does not"],
      [(b) => (sign(b).types.Other = [{ name: "x", type: "uint256" }]), "its authorization has fields a token authorization does not"],
      [(b) => (sign(b).domain.chainId = 1), "it authorizes something other than USDC on Base"],
      [(b) => (sign(b).domain.verifyingContract = "0x0000000000000000000000000000000000000bad"), "it authorizes something other than USDC on Base"],
      [(b) => (sign(b).value.from = "0x0000000000000000000000000000000000000001"), `it spends from 0x0000000000000000000000000000000000000001, not ${OWNER}`],
      [(b) => (sign(b).value.to = "0x0000000000000000000000000000000000000bad"), "it pays 0x0000000000000000000000000000000000000bad, not Relay's approval proxy"],
      [(b) => (sign(b).value.value = "5000001"), "it authorizes 5.000001 USDC, not the 5 asked for"],
      [(b) => (sign(b).value.validAfter = NOW + 60), "it is not usable yet"],
      [(b) => (sign(b).value.validBefore = NOW), "it has lapsed"],
      [(b) => (sign(b).value.validBefore = NOW + 3_601), "it stays usable for more than an hour"],
      [(b) => (sign(b).value.nonce = "0x01"), "its nonce is not 32 bytes"],
      [(b) => (b.steps[0].items[0].data.post.endpoint = "/execute/swap"), "it is not handed to Relay the way an authorization is"],
      [(b) => (b.steps[0].items[0].data.post.body.requestId = `0x${"00".repeat(32)}`), "it is not handed to Relay the way an authorization is"],
      [(b) => (b.details.currencyIn.amount = "9000000"), "its move takes something other than what it authorizes"],
      [(b) => (b.details.recipient = "0x0000000000000000000000000000000000000002"), `it pays 0x0000000000000000000000000000000000000002, not ${OWNER}`],
      [(b) => (b.details.currencyOut.currency.chainId = 8453), "it does not pay the currency asked for on Robinhood Chain"],
      [(b) => (sign(b).value.value = "lots"), "it is in a form this command cannot read"],
      [(b) => delete sign(b).value, "it is in a form this command cannot read"],
    ];
    for (const [change, problem] of cases) expect(readPermit(await quoteOf(body(5_000_000n, change)), want), problem).toBe(problem);
  });
});

describe("signPermit", () => {
  it("signs the authorization Relay asked for, which only this wallet could have signed", async () => {
    const authorization = readPermit(await quoteOf(body()), want) as Authorization;
    const signature = await signPermit(account, authorization);
    const s = sign(body());
    const asked = { address: OWNER, domain: s.domain, types: s.types, primaryType: "ReceiveWithAuthorization" as const, message: s.value, signature };
    expect(await verifyTypedData(asked)).toBe(true);
    expect(await verifyTypedData({ ...asked, message: { ...s.value, value: "5000001" } })).toBe(false);
  });
});

/** Relay's API: a quote, the permit's post and the status, each recorded. */
function relay(options: { quote?: unknown; post?: () => Response | Promise<Response>; status?: RelayStatus; now?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/quote")) return answer(options.quote ?? body());
    if (url.includes("/execute/permits")) return options.post ? options.post() : answer({ message: "ok" });
    return answer({});
  }) as unknown as typeof fetch;
  const mover = createPermitMover({
    account,
    origin: BASE,
    destination: RH,
    again: "fund",
    maxLoss: () => MAX_LOSS,
    fetchImpl,
    now: () => options.now ?? NOW,
    wait: async () => options.status ?? "success",
  });
  return { mover, calls };
}

describe("createPermitMover", () => {
  it("asks Relay for the gasless move with the refund to this wallet, then signs it and hands it over", async () => {
    const { mover, calls } = relay();
    const quote = await mover.preview(NATIVE, 5_000_000n, OWNER);
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ user: OWNER, recipient: OWNER, refundTo: OWNER, originChainId: 8453, destinationChainId: 4663, usePermit: true, amount: "5000000" });
    expect(await mover.send(quote)).toBe(`Relay request ${ID}`);
    const post = calls[1]!;
    const signature = new URL(post.url).searchParams.get("signature") as Hex;
    expect(JSON.parse(String(post.init!.body))).toEqual({ kind: "eip3009", requestId: ID, api: "swap" });
    const s = sign(body());
    expect(await verifyTypedData({ address: OWNER, domain: s.domain, types: s.types, primaryType: "ReceiveWithAuthorization", message: s.value, signature })).toBe(true);
  });

  it("refuses a price above the limit and an authorization that is not the move asked for, before signing", async () => {
    await expect(relay({ quote: body(5_000_000n, (b) => (b.details.currencyOut.amountUsd = "4.0")) }).mover.preview(NATIVE, 5_000_000n, OWNER)).rejects.toThrow(/Relay would keep 1\.00 USD of 5\.00/);
    await expect(relay().mover.preview(NATIVE, 5_000_000n, "0x0000000000000000000000000000000000000003" as Address)).rejects.toThrow(
      `Relay's quote was refused before signing: it pays ${OWNER}, not 0x0000000000000000000000000000000000000003. Nothing was sent.`,
    );
  });

  it("signs only a quote it checked, and checks it again when it signs", async () => {
    const r = relay();
    await expect(r.mover.send((await quoteOf(body())) as RelayQuote)).rejects.toThrow("This quote was not checked before signing. Nothing was sent.");
    let now = NOW;
    const late = createPermitMover({ account, origin: BASE, destination: RH, again: "fund", maxLoss: () => MAX_LOSS, fetchImpl: vi.fn(async () => answer(body())) as unknown as typeof fetch, now: () => now, wait: async () => "success" });
    const quote = await late.preview(NATIVE, 5_000_000n, OWNER);
    now += 431;
    await expect(late.send(quote)).rejects.toThrow("Relay's quote was refused before signing: it has lapsed. Nothing was sent.");
  });

  it("says the USDC did not move only when Relay turned the authorization down, and when it lapses", async () => {
    const refused = relay({ post: () => answer({ message: "Insufficient balance: need 5.0 USDC, have 0.0 USDC." }, 400) });
    await expect(refused.mover.send(await refused.mover.preview(NATIVE, 5_000_000n, OWNER))).rejects.toThrow(
      "Relay did not take the authorization (Insufficient balance: need 5.0 USDC, have 0.0 USDC), so the 5 USDC did not move. Unused, it lapses at 13:13 UTC.",
    );
    for (const post of [() => answer({}, 502), () => Promise.reject(new Error("socket hang up"))]) {
      const unknown = relay({ post });
      await expect(unknown.mover.send(await unknown.mover.preview(NATIVE, 5_000_000n, OWNER))).rejects.toThrow(
        /^Could not tell whether Relay took the authorization \((Relay answered 502|socket hang up)\)\. Check https:\/\/api\.relay\.link\/intents\/status\/v2\?requestId=0x17.* before running fund again: Relay may take the 5 USDC until 13:13 UTC/,
      );
    }
  });

  it("says a refund only when Relay reports one, and asks for a check before another run otherwise", async () => {
    const refund = relay({ status: "refund" });
    await expect(refund.mover.send(await refund.mover.preview(NATIVE, 5_000_000n, OWNER))).rejects.toThrow(`Relay reports a refund for request ${ID}: the 5 USDC goes back to ${OWNER} on Base. Check the wallet before running fund again.`);
    const pending = relay({ status: "pending" });
    await expect(pending.mover.send(await pending.mover.preview(NATIVE, 5_000_000n, OWNER))).rejects.toThrow(`Relay has not settled request ${ID} (it reports "pending"). Check https://api.relay.link/intents/status/v2?requestId=${ID} before running fund again`);
  });
});
