import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Settlers } from "brainchain-verify/zerox";
import { BaseError, decodeFunctionData, encodeFunctionResult, parseEther, parseUnits, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { buyStake, createBuyChain, MAX_OVER_WORTH, SwapReverted, SwapSent, type BuyChain, type BuyDeps, type BuyOptions } from "./buy.js";
import { cli } from "./invoked.js";
import { MAINNET, TESTNET } from "./network.js";
import { PROBE_CODE, probeAbi } from "./probe.js";
import { NotPaid, type PaidQuote } from "./zerox.js";

// Signed answers from 0x's Swap API on 2026-11-21 for a throwaway taker that holds nothing: the exact-out price of
// 312,500 BRAIN, then the exact-in quote for 0x's estimate plus 1.5%, with slippageBps=100.
const recorded = (name: string) => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as { url: string; status: number; headers: Record<string, string>; body: string };
  const body = Buffer.from(f.body, "base64");
  const json = JSON.parse(body.toString("utf8")) as { sellAmount: string; buyAmount: string; minBuyAmount: string; estimatedNetSellAmount: string; transaction: { to: Address; data: Hex; value: string; gas: string } };
  return { ...f, body, json, created: Number(/created=(\d+)/.exec(f.headers["signature-input"]!)![1]) };
};
type Recorded = ReturnType<typeof recorded>;
const ETH_PRICE = recorded("price-exact-out-eth");
const ETH_QUOTE = recorded("quote-exact-in-eth");
const USDG_PRICE = recorded("price-exact-out-usdg");
const USDG_QUOTE = recorded("quote-exact-in-usdg");
const REFUSED = recorded("quote-refused-stock");
const ETH_SALE = BigInt(ETH_QUOTE.json.sellAmount);
const USDG_SALE = BigInt(USDG_QUOTE.json.sellAmount);

const TAKER: Address = "0x89261C04A9aEE508ab7091FA12CD417664634a7D";
const BRAIN = MAINNET.bridge!.tokens!.stake!;
const USDG = MAINNET.bridge!.tokens!.bounty!;
const HOLDER: Address = "0x0000000000001fF3684f28c67538d4D072C22734";
const SETTLERS: Settlers = { current: "0xE8852602f84e04e284286d8Db01a41Edd0CCEFb0", previous: "0x24A4d86c8A76B00EE9566eD9C9Ff4f0c3Faf0da7" };
const STAKE = 312_500n * 10n ** 18n;
const TX: Hex = `0x${"ab".repeat(32)}`;
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
// Relay's prices when the answers were recorded: 312,500 BRAIN was worth 63.19 USD.
const PRICES: Record<string, number> = { "0x0000000000000000000000000000000000000000": 1604.604926, [USDG.toLowerCase()]: 0.999854, [BRAIN.toLowerCase()]: 0.0002021967135 };

function fakeChain(options: { eth?: bigint; usdg?: bigint; brain?: bigint; allowance?: bigint; base?: bigint; spent?: bigint; fails?: Error; code?: Hex; reverts?: boolean } = {}) {
  const sent: string[] = [];
  let brain = options.brain ?? 0n;
  const chain: BuyChain = {
    account: TAKER,
    eth: vi.fn(async () => options.eth ?? parseEther("1")),
    balance: vi.fn(async (token: Address) => (token === BRAIN ? brain : (options.usdg ?? parseUnits("500", 6)))),
    allowance: vi.fn(async () => options.allowance ?? 0n),
    gasPrice: vi.fn(async () => 22_563_000n),
    code: vi.fn(async () => options.code),
    blockTime: vi.fn(async () => BigInt(ETH_QUOTE.created)),
    paymentBalance: vi.fn(async () => options.base ?? 1_000_000n),
    settlers: vi.fn(async () => SETTLERS),
    simulate: vi.fn(async (_swap, sold: Address) => {
      if (options.fails) throw options.fails;
      const quote = sold === USDG ? USDG_QUOTE : ETH_QUOTE;
      return { spent: options.spent ?? BigInt(quote.json.sellAmount), gained: BigInt(quote.json.buyAmount) };
    }),
    approve: vi.fn(async (token: Address, spender: Address, amount: bigint) => {
      sent.push(`approve ${token} ${spender} ${amount}`);
      return TX;
    }),
    send: vi.fn(async (swap, onSent?: (hash: Hex) => void) => {
      sent.push(`swap ${swap.to} ${swap.value} ${swap.data.slice(0, 10)}`);
      onSent?.(TX);
      if (options.reverts) throw new SwapReverted(TX);
      brain += BigInt((swap.value > 0n ? ETH_QUOTE : USDG_QUOTE).json.buyAmount);
      return TX;
    }),
  };
  return { chain, sent };
}

function deps(chain: BuyChain, overrides: Partial<BuyDeps> & { fixture?: Recorded; priced?: Recorded } = {}) {
  const { fixture = ETH_QUOTE, priced = fixture === USDG_QUOTE ? USDG_PRICE : ETH_PRICE, ...rest } = overrides;
  const asked: Record<string, string>[] = [];
  const bridged: bigint[] = [];
  const d: BuyDeps = {
    chain,
    needs: async () => ({ need: STAKE, held: 0n }),
    stakeProblem: async () => undefined,
    inFlight: async () => undefined,
    price: async (token) => PRICES[token.toLowerCase()]!,
    quote: vi.fn(async (query, kind): Promise<PaidQuote> => {
      asked.push(query);
      const f = kind === "price" ? priced : fixture;
      return { url: f.url, response: { status: f.status, headers: f.headers, body: f.body }, payment: `0x${kind}` };
    }),
    bridge: async (amount) => void bridged.push(amount),
    now: () => (fixture.created + 2) * 1000,
    ...rest,
  };
  return { deps: d, asked, bridged };
}

async function run(d: BuyDeps, options: Partial<BuyOptions> = {}) {
  const lines: string[] = [];
  await buyStake(MAINNET, d, { pay: "eth", dry: false, yes: true, log: (line) => lines.push(line), ...options });
  return lines;
}

/** The most buy-stake spends on 312,500 BRAIN at PRICES, in the sold token's smallest units. */
const ceiling = (token: string, decimals: number) => BigInt(Math.floor(((312_500 * PRICES[BRAIN.toLowerCase()]! * (1 + MAX_OVER_WORTH)) / PRICES[token]!) * 10 ** decimals));

// The lines buy-stake prints for the fixtures at PRICES, checked by hand.
const SUMMARY_ETH = [
  "0x quotes 318,377 BRAIN for exactly 0.041438 ETH (66.49 USD, 5.2% over what 312,500 BRAIN is worth). The sale spends that and no more, so it is also the worst case; the swap reverts below 315,194 BRAIN, and join needs 312,500 BRAIN.",
  "  For the 318,377 BRAIN expected in the simulation, that is 3.3% over Relay's price for each; the 5,877 BRAIN beyond what join needs stay in the wallet on Robinhood Chain.",
  "  At Relay's price of 0.000202 USD, 312,500 BRAIN is worth 63.19 USD, and buy-stake spends at most 7% over that, 0.042134 ETH. 0x's fee of 0.000063 ETH is included.",
  "  Checked: 0x's signature (key 0x-signing-key-prod-24092026, signed 2 seconds ago); the transaction calls 0x's AllowanceHolder 0x0000…2734, which lets Settler 0xE885…EFb0, the one 0x's registry names, take exactly 0.041438 ETH; it pays the BRAIN to 0x8926…4a7D and reverts below 315,194 BRAIN.",
  "  Simulated on Robinhood Chain: it takes 0.041437 ETH and brings 318,377 BRAIN.",
  "  Gas on Robinhood Chain: about 0.000011 ETH for the swap.",
];
const PROMPT_ETH = "Buy about 318,377 BRAIN, at least 315,194 BRAIN, for exactly 0.041438 ETH (66.49 USD, 5.2% over what 312,500 BRAIN is worth)? [y/N] ";
const LACKS_ETH = `${TAKER} holds 0.042134 ETH on Robinhood Chain, and needs about 0.042469 ETH: up to 0.042135 ETH for the sale, 0.000034 ETH for gas and 0.0003 ETH kept for the bridge's deposit.\nNothing was paid.`;
const DRY_LACKS_ETH = `${TAKER} holds 0.0002 ETH on Robinhood Chain, and needs about 0.042445 ETH: up to 0.042135 ETH for the sale, 0.000011 ETH for gas and 0.0003 ETH kept for the bridge's deposit.\nDry run: 0.02 USDC paid for a price and a quote, nothing else sent.`;
const LACKS_USDG_MOST = "67.619398";

describe("buy-stake", () => {
  it("prices the BRAIN join is short of, buys an exact-in quote for 0x's estimate plus 1.5%, sends it and bridges what join needs", async () => {
    const { chain, sent } = fakeChain();
    const saved: Hex[] = [];
    const { deps: d, asked, bridged } = deps(chain, { swapSent: (hash) => void saved.push(hash) });
    const lines = await run(d);
    const estimate = BigInt(ETH_PRICE.json.estimatedNetSellAmount);
    expect(ETH_SALE).toBe((estimate * 1015n + 999n) / 1000n);
    expect(asked).toEqual([
      { chainId: "4663", sellToken: ETH, buyToken: BRAIN, taker: TAKER, buyAmount: STAKE.toString() },
      { chainId: "4663", sellToken: ETH, buyToken: BRAIN, taker: TAKER, sellAmount: ETH_SALE.toString(), slippageBps: "100" },
    ]);
    expect(vi.mocked(d.quote).mock.calls.map((call) => call[1])).toEqual(["price", "quote"]);
    expect(sent).toEqual([`swap ${HOLDER} ${ETH_SALE} 0x2213bc0b`]);
    expect(saved).toEqual([TX]);
    expect(bridged).toEqual([STAKE]);
    expect(lines[0]).toBe(`join needs 312,500 BRAIN on BrainChain. ${TAKER} holds 0 BRAIN on BrainChain, so this buys at least 312,500 BRAIN with ETH on Robinhood Chain, through 0x.`);
    expect(lines).toContain("Paid 0x 0.01 USDC on Base for a price: 0xprice");
    expect(lines).toContain("Paid 0x 0.01 USDC on Base for a quote: 0xquote");
    expect(lines.find((line) => line.startsWith("0x quotes"))!.split("\n")).toEqual(SUMMARY_ETH);
    expect(lines).toContain(`Bought 318,377 BRAIN on Robinhood Chain: ${TX}. The 5,877 BRAIN beyond what join needs stay in the wallet there.`);
  });

  it("spends at most 7% over the BRAIN's worth, and refuses after the price, before paying for a quote, when the sale would spend more", async () => {
    // At a BRAIN price 3% lower the same sale is about 8.5% over the BRAIN's worth.
    const cheaper = { ...PRICES, [BRAIN.toLowerCase()]: PRICES[BRAIN.toLowerCase()]! * 0.97 };
    const { chain, sent } = fakeChain();
    const { deps: d } = deps(chain, { price: async (token) => cheaper[token.toLowerCase()]! });
    await expect(run(d)).rejects.toThrow(
      "0x prices 312,500 BRAIN at 0.040826 ETH, so a sale that brings at least that many spends 0.041438 ETH (66.49 USD, 8.5% over what 312,500 BRAIN is worth), more than the 7% buy-stake accepts, 0.04087 ETH. " +
        `Try again later, or buy at ripples.run and use ${cli("bridge --stake")}. The 0.01 USDC paid to 0x is spent; nothing else was sent.`,
    );
    expect(vi.mocked(d.quote).mock.calls.map((call) => call[1])).toEqual(["price"]);
    expect(chain.simulate).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("names what a sale left on Robinhood Chain in whole BRAIN, and the rest to buy rounded up", async () => {
    const left = 5_939_584_120_497_792_051_254n;
    const { chain } = fakeChain({ brain: left });
    const { deps: d } = deps(chain, { inFlight: async () => "stop here" });
    const lines: string[] = [];
    await expect(buyStake(MAINNET, d, { pay: "eth", dry: true, yes: false, log: (line) => lines.push(line) })).rejects.toThrow("stop here. Nothing was paid.");
    expect(lines[0]).toBe(`join needs 312,500 BRAIN on BrainChain. ${TAKER} holds 0 BRAIN on BrainChain and 5,939 BRAIN on Robinhood Chain, so this buys at least 306,561 BRAIN with ETH on Robinhood Chain, through 0x.`);
  });

  it("counts BRAIN on BrainChain and on Robinhood Chain, buys the rest, and bridges both", async () => {
    const { chain } = fakeChain({ brain: 50_000n * 10n ** 18n });
    const { deps: d, asked, bridged } = deps(chain, { needs: async () => ({ need: STAKE + 70_000n * 10n ** 18n, held: 20_000n * 10n ** 18n }) });
    await run(d);
    expect(asked[0]!.buyAmount).toBe(STAKE.toString());
    expect(bridged).toEqual([STAKE + 50_000n * 10n ** 18n]);
  });

  it("buys nothing when nothing is missing, and says what to run instead", async () => {
    const cases: [Partial<BuyDeps>, bigint, string][] = [
      [{ needs: async () => ({ need: 0n, held: 0n }) }, 0n, "This worker's stake is at the minimum and it applies for nothing, so there is no BRAIN to buy."],
      [{ needs: async () => ({ need: STAKE, held: STAKE }) }, 0n, `The wallet holds the 312,500 BRAIN join needs on BrainChain. Run ${cli("join")}.`],
      [{}, STAKE * 2n, `The wallet already holds 625,000 BRAIN on Robinhood Chain, which covers the 312,500 BRAIN join still needs. Move it with ${cli("bridge --stake 312500")}, then run ${cli("join")}.`],
    ];
    for (const [overrides, brain, line] of cases) {
      const { chain, sent } = fakeChain({ brain });
      const { deps: d } = deps(chain, overrides);
      expect(await run(d)).toEqual([line]);
      expect(d.quote).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    }
  });

  it("stops before any request when the wallet has less than 0.02 USDC on Base, a price and a quote", async () => {
    const { chain } = fakeChain({ base: 19_999n });
    const { deps: d } = deps(chain);
    await expect(run(d, { dry: true })).rejects.toThrow(
      `buy-stake pays 0x 0.01 USDC on Base for a price and 0.01 USDC for a quote, from the worker's own key, and ${TAKER} holds 0.019999 USDC there. Send that address at least 0.02 USDC on Base. Nothing was paid.`,
    );
    expect(d.quote).not.toHaveBeenCalled();
  });

  it("stops before any request on a release BrainChain has moved past, without Relay's prices, or with a paused or unread Settler registry", async () => {
    const paused = fakeChain().chain;
    paused.settlers = async () => ({});
    const unread = fakeChain().chain;
    unread.settlers = async () => Promise.reject(new Error("fetch failed"));
    for (const [chain, overrides, message] of [
      [fakeChain().chain, { stakeProblem: async () => "This release of brainchain-worker is for an earlier set. Update with npx brainchain-worker@latest" }, "This release of brainchain-worker is for an earlier set. Update with npx brainchain-worker@latest. Nothing was paid."],
      [fakeChain().chain, { price: async () => Promise.reject(new Error("Relay has no price")) }, "Could not read prices from Relay, which the spend is measured against (Relay has no price). Nothing was paid."],
      [paused, {}, "0x's registry on Robinhood Chain says its Settler is paused, so no quote could be sent now. Try again later. Nothing was paid."],
      [unread, {}, "Could not read 0x's Settler registry on Robinhood Chain (fetch failed). Nothing was paid."],
    ] as [BuyChain, Partial<BuyDeps>, string][]) {
      const { deps: d } = deps(chain, overrides);
      await expect(run(d, { dry: true })).rejects.toThrow(message);
      expect(d.quote).not.toHaveBeenCalled();
    }
  });

  it("stops before any request while an earlier swap or deposit from this wallet is in flight", async () => {
    const { chain, sent } = fakeChain();
    const inFlight = "A deposit of 312,500 BRAIN from this wallet, sent 2 minutes ago (0xfe), has not arrived on BrainChain yet, and buying now would buy it again";
    const { deps: d } = deps(chain, { inFlight: async () => inFlight });
    await expect(run(d, { dry: true })).rejects.toThrow(`${inFlight}. Nothing was paid.`);
    expect(d.quote).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("stops before any request for an address with code, such as an EIP-7702 delegation, or a clock off the chain's", async () => {
    const delegated = fakeChain({ code: `0xef0100${"11".repeat(20)}` });
    const { deps: d } = deps(delegated.chain);
    await expect(run(d)).rejects.toThrow(
      `buy-stake needs a plain key: ${TAKER} has code on Robinhood Chain, an EIP-7702 delegation or a contract wallet, and the swap is checked as if it had none. Nothing was paid.`,
    );
    expect(d.quote).not.toHaveBeenCalled();
    expect((await run(deps(fakeChain({ code: "0x" }).chain).deps)).some((line) => line.startsWith("Bought "))).toBe(true);

    const skewed = deps(fakeChain().chain, { now: () => (ETH_QUOTE.created + 31) * 1000 }).deps;
    await expect(run(skewed)).rejects.toThrow("This machine's clock is 31 seconds ahead of Robinhood Chain's latest block, and 0x's quote is checked against it. Set the clock right and run again. Nothing was paid.");
    expect(skewed.quote).not.toHaveBeenCalled();
  });

  it("stops before any request when the wallet cannot cover the most it may spend, gas and the ETH kept, or lacks ETH for gas on a USDG buy", async () => {
    const most = ceiling("0x0000000000000000000000000000000000000000", 18);
    const poor = deps(fakeChain({ eth: most }).chain).deps;
    await expect(run(poor)).rejects.toThrow(LACKS_ETH);
    expect(poor.quote).not.toHaveBeenCalled();
    const noGas = deps(fakeChain({ eth: parseEther("0.0001") }).chain, { fixture: USDG_QUOTE }).deps;
    await expect(run(noGas, { pay: "usdg" })).rejects.toThrow(new RegExp(`^${TAKER} holds 0\\.0001 ETH on Robinhood Chain, and needs about 0\\.000\\d+ ETH: 0\\.0000\\d+ ETH for gas and 0\\.0003 ETH kept`));
    expect(noGas.quote).not.toHaveBeenCalled();
    const fewUsdg = deps(fakeChain({ usdg: parseUnits("60", 6) }).chain, { fixture: USDG_QUOTE }).deps;
    await expect(run(fewUsdg, { pay: "usdg" })).rejects.toThrow(`${TAKER} holds 60 USDG on Robinhood Chain, and the sale may take up to ${LACKS_USDG_MOST} USDG.\nNothing was paid.`);
    expect(fewUsdg.quote).not.toHaveBeenCalled();
  });

  it("refuses to start without a terminal or --yes, before it pays for anything", async () => {
    const { chain } = fakeChain();
    const { deps: d } = deps(chain);
    await expect(run(d, { yes: false })).rejects.toThrow("There is no terminal to confirm on. Run again with --yes to buy without asking, or with --dry to see the quote.");
    expect(d.quote).not.toHaveBeenCalled();
  });

  it("says a dry run costs 0.02 USDC, buys the price and the quote, simulates as if funded, sends nothing else and exits 1 on what the wallet lacks", async () => {
    const { chain, sent } = fakeChain({ eth: parseEther("0.0002") });
    const { deps: d, bridged } = deps(chain);
    const lines: string[] = [];
    const dry = buyStake(MAINNET, d, { pay: "eth", dry: true, yes: false, log: (line) => lines.push(line) });
    await expect(dry).rejects.toThrow(DRY_LACKS_ETH);
    expect(lines[1]).toBe("Dry run: buys a price and a quote from 0x, 0.01 USDC each on Base, and sends nothing else.");
    expect(d.quote).toHaveBeenCalledTimes(2);
    expect(chain.simulate).toHaveBeenCalledWith(expect.anything(), ETH, BRAIN, { lend: ETH_SALE + parseEther("10") });
    expect(lines.some((line) => line.includes("Simulated on Robinhood Chain, as if the wallet held the ETH: it takes 0.041437 ETH"))).toBe(true);
    expect(sent).toEqual([]);
    expect(bridged).toEqual([]);

    const funded = await run(deps(fakeChain().chain).deps, { dry: true, yes: false });
    expect(funded.at(-1)).toBe("Dry run: 0.02 USDC paid for a price and a quote, nothing else sent.");
  });

  it("asks before it buys, with the exact spend and the BRAIN expected, and before it bridges, and does neither on a no", async () => {
    const answers = ["n"];
    const { chain, sent } = fakeChain();
    const { deps: d, bridged } = deps(chain);
    const ask = vi.fn(async () => answers.shift() ?? "n");
    expect((await run(d, { yes: false, ask })).at(-1)).toBe("Nothing sent. The 0.02 USDC paid to 0x is spent.");
    expect(ask).toHaveBeenCalledWith(PROMPT_ETH);
    expect(sent).toEqual([]);

    answers.push("y", "no");
    const lines = await run(d, { yes: false, ask });
    expect(ask).toHaveBeenLastCalledWith(`Move 312,500 BRAIN to BrainChain now with ${cli("bridge --stake 312500")}? [y/N] `);
    expect(lines.at(-1)).toBe(`The BRAIN stays on Robinhood Chain. ${cli("bridge --stake 312500")} moves it, then ${cli("join")} stakes it.`);
    expect(sent).toHaveLength(1);
    expect(bridged).toEqual([]);
  });

  it("approves exactly the USDG the sale spends, to AllowanceHolder, after simulating with the approval twice", async () => {
    const { chain, sent } = fakeChain({ usdg: parseUnits("200", 6) });
    const order: string[] = [];
    chain.simulate = vi.fn(async (_swap, _sold, _bought, options) => {
      order.push(`simulate ${options?.approve}`);
      return { spent: USDG_SALE, gained: BigInt(USDG_QUOTE.json.buyAmount) };
    });
    const approve = chain.approve;
    chain.approve = vi.fn(async (token: Address, spender: Address, amount: bigint) => {
      order.push("approve");
      return approve(token, spender, amount);
    });
    const { deps: d, asked } = deps(chain, { fixture: USDG_QUOTE });
    const lines = await run(d, { pay: "usdg" });
    expect(asked[1]).toEqual({ chainId: "4663", sellToken: USDG, buyToken: BRAIN, taker: TAKER, sellAmount: USDG_SALE.toString(), slippageBps: "100" });
    expect(sent).toEqual([`approve ${USDG} ${HOLDER} ${USDG_SALE}`, `swap ${HOLDER} 0 0x2213bc0b`]);
    expect(order).toEqual([`simulate ${USDG_SALE}`, `simulate ${USDG_SALE}`, "approve"]);
    expect(lines.join("\n")).toContain("0x's fee of 0.099792 USDG is included.");
  });

  it("does not simulate a USDG sale the wallet cannot fund on a dry run, and says what it lacks", async () => {
    const { chain } = fakeChain({ usdg: parseUnits("60", 6) });
    const { deps: d } = deps(chain, { fixture: USDG_QUOTE });
    const lines: string[] = [];
    await expect(buyStake(MAINNET, d, { pay: "usdg", dry: true, yes: false, log: (line) => lines.push(line) })).rejects.toThrow(
      `${TAKER} holds 60 USDG on Robinhood Chain, and the sale may take up to ${LACKS_USDG_MOST} USDG.\nDry run: 0.02 USDC paid for a price and a quote, nothing else sent.`,
    );
    expect(chain.simulate).not.toHaveBeenCalled();
    expect(lines.some((line) => line.includes("Not simulated: the wallet holds 60 USDG of the 66.527993 USDG the sale takes."))).toBe(true);
  });

  it("refuses a price or a quote that fails a check, saying which and what was paid", async () => {
    // Signed 70 seconds before it was checked, by a clock that agrees with the chain's.
    const late = fakeChain();
    late.chain.blockTime = async () => BigInt(ETH_PRICE.created + 70);
    const lateDeps = deps(late.chain, { now: () => (ETH_PRICE.created + 70) * 1000 }).deps;
    await expect(run(lateDeps)).rejects.toThrow(/^0x's price could not be used: 0x signed 70 seconds ago, outside the 60 seconds .*\. The 0\.01 USDC paid to 0x is spent; nothing else was sent\.$/);
    expect(lateDeps.quote).toHaveBeenCalledOnce();
    const refused = deps(fakeChain().chain, { priced: REFUSED, now: () => (REFUSED.created + 2) * 1000 }).deps;
    refused.chain.blockTime = async () => BigInt(REFUSED.created + 2);
    await expect(run(refused)).rejects.toThrow(/^0x's price could not be used: 0x answered 422 BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE: The buy token is not authorized for trade/);
    const other = deps(fakeChain().chain, { needs: async () => ({ need: STAKE + 1n, held: 0n }) }).deps;
    await expect(run(other)).rejects.toThrow("0x's price could not be used: it is not an exact-out price for this trade. The 0.01 USDC paid to 0x is spent; nothing else was sent.");
    // The registry read before paying names the Settler, and the one read to check the quote names another.
    const counterfeit = fakeChain();
    let reads = 0;
    counterfeit.chain.settlers = async () => (reads++ === 0 ? SETTLERS : { current: "0x4444444444444444444444444444444444444444" });
    await expect(run(deps(counterfeit.chain).deps)).rejects.toThrow(/Settler 0xE8852602f84e04e284286d8Db01a41Edd0CCEFb0 is neither the registry's current Settler.*The 0\.02 USDC paid to 0x is spent; nothing else was sent\.$/);
    expect([...late.sent, ...counterfeit.sent]).toEqual([]);
  });

  it("says what was paid when the gateway refuses to sell the quote after the price", async () => {
    const { chain } = fakeChain();
    const { deps: d } = deps(chain);
    const priced = d.quote;
    d.quote = async (query, kind) => {
      if (kind === "quote") throw new NotPaid("0x's gateway refused the payment (402). Nothing was paid.");
      return priced(query, kind);
    };
    await expect(run(d)).rejects.toThrow("0x's gateway refused the payment (402). Nothing was paid for the quote; the price's 0.01 USDC is spent.");
  });

  it("refuses a price or quote signed by a key this release does not carry, and says to update", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const rotate = (f: Recorded) => {
      const params = `("@status" "content-type" "content-digest" "@method";req "@authority";req "@path";req "@query";req);created=${f.created};keyid="0x-signing-key-next";alg="ed25519";tag="0x-swap-api"`;
      return { ...f, headers: { ...f.headers, "signature-input": `sig=${params}`, signature: `sig=:${sign(null, Buffer.from("any"), privateKey).toString("base64")}:` } };
    };
    const update = "0x signed it with key 0x-signing-key-next, which this release does not carry. Update with npx brainchain-worker@latest.";
    const { chain, sent } = fakeChain();
    await expect(run(deps(chain, { priced: rotate(ETH_PRICE) }).deps)).rejects.toThrow(`0x's price could not be used: ${update} The 0.01 USDC paid to 0x is spent; nothing else was sent.`);
    await expect(run(deps(chain, { fixture: rotate(ETH_QUOTE), priced: ETH_PRICE }).deps)).rejects.toThrow(`0x's quote was refused before anything was signed: ${update} The 0.02 USDC paid to 0x is spent; nothing else was sent.`);
    expect(sent).toEqual([]);
  });

  it("sends nothing when the swap fails in simulation, before or after the person answers, and says when the quote expired", async () => {
    const failing = fakeChain({ fails: new Error("execution reverted") });
    await expect(run(deps(failing.chain).deps)).rejects.toThrow("0x's transaction fails when simulated on Robinhood Chain: execution reverted. The 0.02 USDC paid to 0x is spent; nothing else was sent.");
    expect(failing.sent).toEqual([]);

    const { chain, sent } = fakeChain({ usdg: parseUnits("200", 6) });
    let simulations = 0;
    const expired = new BaseError("execution reverted", { cause: Object.assign(new Error("reverted"), { data: `${toFunctionSelector("SignatureExpired(uint256)")}${"00".repeat(31)}01` }) });
    chain.simulate = vi.fn(async () => {
      simulations += 1;
      if (simulations > 1) throw expired;
      return { spent: USDG_SALE, gained: BigInt(USDG_QUOTE.json.buyAmount) };
    });
    await expect(run(deps(chain, { fixture: USDG_QUOTE }).deps, { pay: "usdg" })).rejects.toThrow(
      "The quote expired before it was sent: run buy-stake again (a new price and quote cost 0.02 USDC). Nothing was sent. The 0.02 USDC paid to 0x is spent.",
    );
    expect(sent).toEqual([]);
  });

  it("says nothing was bought when the swap reverts or cannot be sent, and whether the approval stays", async () => {
    const usdg = fakeChain({ usdg: parseUnits("200", 6), reverts: true });
    await expect(run(deps(usdg.chain, { fixture: USDG_QUOTE }).deps, { pay: "usdg" })).rejects.toThrow(
      `The swap reverted on Robinhood Chain (${TX}), so nothing was bought. The approval of 66.527993 USDG to AllowanceHolder stays, and only this wallet's own transactions can use it.`,
    );
    const eth = fakeChain({ reverts: true });
    await expect(run(deps(eth.chain).deps)).rejects.toThrow(new RegExp(`^The swap reverted on Robinhood Chain \\(${TX}\\), so nothing was bought\\.$`));
    const refused = fakeChain();
    refused.chain.send = async () => Promise.reject(new Error("nonce too low"));
    await expect(run(deps(refused.chain).deps)).rejects.toThrow("The swap could not be sent (nonce too low), so nothing was bought.");
    const unconfirmed = fakeChain();
    unconfirmed.chain.send = async () => Promise.reject(new SwapSent("The swap was sent on Robinhood Chain (0xab) and could not be confirmed"));
    await expect(run(deps(unconfirmed.chain).deps)).rejects.toThrow(/^The swap was sent on Robinhood Chain \(0xab\) and could not be confirmed$/);
  });

  it("says where the BRAIN is when the bridge fails after the buy", async () => {
    const { chain } = fakeChain();
    const { deps: d } = deps(chain, { bridge: async () => Promise.reject(new Error("the deposit reverted")) });
    await expect(run(d)).rejects.toThrow(`the deposit reverted. The BRAIN is on Robinhood Chain; ${cli("bridge --stake 312500")} moves it.`);
  });

  it("runs on mainnet only", async () => {
    const { chain } = fakeChain();
    await expect(buyStake(TESTNET, deps(chain).deps, { pay: "eth", dry: true, yes: false, log: () => {} })).rejects.toThrow("buy-stake works on mainnet only");
  });

  it("simulates in one eth_call from the worker, within the swap's gas, with the probe placed at its address and the approval made from it", async () => {
    const worker = privateKeyToAccount(`0x${"77".repeat(32)}`);
    const calls: { from?: string; gas?: string; to: string; data: Hex; override: Record<string, { code?: string; balance?: string }> }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const { id, params } = JSON.parse(body) as { id: number; params: [{ from?: string; gas?: string; to: string; data: Hex }, string, Record<string, { code?: string; balance?: string }>] };
        calls.push({ ...params[0], override: params[2] });
        const result = encodeFunctionResult({ abi: probeAbi, functionName: "probe", result: [5n, STAKE] });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const chain = createBuyChain({ ...MAINNET, bridge: { ...MAINNET.bridge!, rpc } }, worker);
      const swap = { to: HOLDER, data: ETH_QUOTE.json.transaction.data, value: 0n, gas: 1_000_000n };
      expect(await chain.simulate(swap, USDG, BRAIN, { approve: 7n })).toEqual({ spent: 5n, gained: STAKE });
      expect(calls[0]!.to.toLowerCase()).toBe(worker.address.toLowerCase());
      expect(calls[0]!.from?.toLowerCase()).toBe(worker.address.toLowerCase());
      expect(BigInt(calls[0]!.gas!)).toBe(1_060_000n);
      expect(calls[0]!.override[worker.address]).toEqual({ code: PROBE_CODE });
      const { args } = decodeFunctionData({ abi: probeAbi, data: calls[0]!.data });
      expect(args).toEqual([USDG, BRAIN, 7n, HOLDER, 0n, ETH_QUOTE.json.transaction.data]);
      await chain.simulate({ ...swap, value: 1n }, ETH, BRAIN, { lend: 10n });
      expect(BigInt(calls[1]!.gas!)).toBe(1_000_000n);
      expect(calls[1]!.override[worker.address]).toEqual({ code: PROBE_CODE, balance: "0xa" });
    } finally {
      server.close();
    }
  });
});
