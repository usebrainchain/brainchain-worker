import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Settlers } from "brainchain-verify/zerox";
import { decodeFunctionData, encodeFunctionResult, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { buyStake, createBuyChain, type BuyChain, type BuyDeps, type BuyOptions } from "./buy.js";
import { cli } from "./invoked.js";
import { MAINNET, TESTNET } from "./network.js";
import { PROBE_CODE, probeAbi } from "./probe.js";
import type { PaidQuote } from "./zerox.js";

// Signed quotes bought through 0x's keyless gateway on 2026-11-21 for a throwaway taker that holds nothing.
const recorded = (name: string) => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as { url: string; status: number; headers: Record<string, string>; body: string };
  const body = Buffer.from(f.body, "base64");
  const json = JSON.parse(body.toString("utf8")) as { maxSellAmount: string; estimatedNetSellAmount: string; transaction: { to: Address; data: Hex; value: string; gas: string } };
  return { ...f, body, json, created: Number(/created=(\d+)/.exec(f.headers["signature-input"]!)![1]) };
};
const ETH_QUOTE = recorded("quote-exact-out-eth");
const USDG_QUOTE = recorded("quote-exact-out-usdg");

const TAKER: Address = "0x89261C04A9aEE508ab7091FA12CD417664634a7D";
const BRAIN = MAINNET.bridge!.tokens!.stake!;
const USDG = MAINNET.bridge!.tokens!.bounty!;
const HOLDER: Address = "0x0000000000001fF3684f28c67538d4D072C22734";
const SETTLERS: Settlers = { current: "0xE8852602f84e04e284286d8Db01a41Edd0CCEFb0", previous: "0x24A4d86c8A76B00EE9566eD9C9Ff4f0c3Faf0da7" };
const STAKE = 312_500n * 10n ** 18n;
const TX: Hex = `0x${"ab".repeat(32)}`;
// Relay's prices on 2026-11-21.
const PRICES: Record<string, number> = { "0x0000000000000000000000000000000000000000": 1620.674657, [USDG.toLowerCase()]: 0.999919, [BRAIN.toLowerCase()]: 0.000397345866278 };

function fakeChain(options: { eth?: bigint; usdg?: bigint; brain?: bigint; allowance?: bigint; base?: bigint; spent?: bigint; fails?: boolean } = {}) {
  const sent: string[] = [];
  let brain = options.brain ?? 0n;
  const chain: BuyChain = {
    account: TAKER,
    eth: vi.fn(async () => options.eth ?? parseEther("1")),
    balance: vi.fn(async (token: Address) => (token === BRAIN ? brain : (options.usdg ?? parseUnits("500", 6)))),
    allowance: vi.fn(async () => options.allowance ?? 0n),
    gasPrice: vi.fn(async () => 22_560_750n),
    paymentBalance: vi.fn(async () => options.base ?? 1_000_000n),
    settlers: vi.fn(async () => SETTLERS),
    simulate: vi.fn(async (_swap, sold: Address) => {
      if (options.fails) throw new Error("execution reverted");
      const quote = sold === USDG ? USDG_QUOTE : ETH_QUOTE;
      return { spent: options.spent ?? BigInt(quote.json.estimatedNetSellAmount), gained: STAKE };
    }),
    approve: vi.fn(async (token: Address, spender: Address, amount: bigint) => {
      sent.push(`approve ${token} ${spender} ${amount}`);
      return TX;
    }),
    send: vi.fn(async (swap) => {
      sent.push(`swap ${swap.to} ${swap.value} ${swap.data.slice(0, 10)}`);
      brain += STAKE;
      return TX;
    }),
  };
  return { chain, sent };
}

function deps(chain: BuyChain, overrides: Partial<BuyDeps> & { fixture?: ReturnType<typeof recorded> } = {}) {
  const fixture = overrides.fixture ?? ETH_QUOTE;
  const asked: Record<string, string>[] = [];
  const bridged: bigint[] = [];
  const d: BuyDeps = {
    chain,
    needs: async () => ({ need: STAKE, held: 0n }),
    stakeProblem: async () => undefined,
    price: async (token) => PRICES[token.toLowerCase()]!,
    quote: vi.fn(async (query): Promise<PaidQuote> => {
      asked.push(query);
      return { url: fixture.url, response: { status: fixture.status, headers: fixture.headers, body: fixture.body }, payment: "0xpaid" };
    }),
    bridge: async (amount) => void bridged.push(amount),
    now: () => (fixture.created + 2) * 1000,
    ...overrides,
  };
  return { deps: d, asked, bridged };
}

async function run(d: BuyDeps, options: Partial<BuyOptions> = {}) {
  const lines: string[] = [];
  await buyStake(MAINNET, d, { pay: "eth", dry: false, yes: true, log: (line) => lines.push(line), ...options });
  return lines;
}

describe("buy-stake", () => {
  it("buys exactly the BRAIN join is short of, checks 0x's quote, sends it and bridges it", async () => {
    const { chain, sent } = fakeChain();
    const { deps: d, asked, bridged } = deps(chain);
    const lines = await run(d);
    expect(asked).toEqual([{ chainId: "4663", sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", buyToken: BRAIN, buyAmount: STAKE.toString(), taker: TAKER }]);
    expect(sent).toEqual([`swap ${HOLDER} ${ETH_QUOTE.json.maxSellAmount} 0x2213bc0b`]);
    expect(bridged).toEqual([STAKE]);
    expect(lines[0]).toBe(`join needs 312,500 BRAIN on BrainChain. ${TAKER} holds 0 BRAIN on BrainChain, so this buys 312,500 BRAIN with ETH on Robinhood Chain, through 0x.`);
    expect(lines).toContain("Paid 0x 0.01 USDC on Base: 0xpaid");
    const shown = lines.find((line) => line.startsWith("0x quotes"))!;
    expect(shown).toContain("0x quotes 312,500 BRAIN for 0.07966 ETH (129.10 USD), at most 0.084363 ETH; what the swap does not use comes back in the same transaction.");
    expect(shown).toContain("At Relay's price of 0.000397 USD, 312,500 BRAIN is worth 124.17 USD: the route costs 3.8% more, 0x's 0.15% fee included, within the 5% this command accepts.");
    expect(shown).toContain("Checked: 0x's signature (key 0x-signing-key-prod-24092026, signed 2 seconds ago); the transaction calls 0x's AllowanceHolder 0x0000…2734, which lets Settler 0xE885…EFb0, the one 0x's registry names, take at most 0.084363 ETH");
    expect(shown).toContain("Simulated on Robinhood Chain: it takes 0.07966 ETH and brings 312,500 BRAIN.");
    expect(lines).toContain(`Bought 312,500 BRAIN on Robinhood Chain: ${TX}`);
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

  it("stops before any request when the wallet has less than 0.01 USDC on Base", async () => {
    const { chain } = fakeChain({ base: 9_999n });
    const { deps: d } = deps(chain);
    await expect(run(d, { dry: true })).rejects.toThrow(
      `buy-stake pays 0x 0.01 USDC on Base for its quote, from the worker's own key, and ${TAKER} holds 0.009999 USDC there. Send that address at least 0.01 USDC on Base. Nothing was paid.`,
    );
    expect(d.quote).not.toHaveBeenCalled();
  });

  it("stops before any request on a stake token nothing stakes, without Relay's prices, or for a wallet that cannot pay BRAIN's price", async () => {
    for (const [overrides, chainOptions, message] of [
      [{ stakeProblem: async () => "This release of brainchain-worker names an old token" }, {}, "This release of brainchain-worker names an old token. Nothing was paid."],
      [{ price: async () => Promise.reject(new Error("Relay has no price")) }, {}, "Could not read prices from Relay, which the loss limit is measured against (Relay has no price). Nothing was paid."],
      [{}, { eth: parseEther("0.05") }, `${TAKER} holds 0.05 ETH on Robinhood Chain. 312,500 BRAIN is worth 124.17 USD at BRAIN's price, about 0.076617 ETH, before 0x's fee and the market's cost. Nothing was paid.`],
    ] as [Partial<BuyDeps>, Parameters<typeof fakeChain>[0], string][]) {
      const { chain, sent } = fakeChain(chainOptions);
      const { deps: d } = deps(chain, overrides);
      await expect(run(d)).rejects.toThrow(message);
      expect(d.quote).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    }
  });

  it("refuses to start without a terminal or --yes, before it pays for anything", async () => {
    const { chain } = fakeChain();
    const { deps: d } = deps(chain);
    await expect(run(d, { yes: false })).rejects.toThrow("There is no terminal to confirm on. Run again with --yes to buy without asking, or with --dry to see the quote.");
    expect(d.quote).not.toHaveBeenCalled();
  });

  it("says a dry run costs 0.01 USDC, buys the quote, simulates it as if funded, and sends nothing else", async () => {
    const { chain, sent } = fakeChain({ eth: parseEther("0.0002") });
    const { deps: d, bridged } = deps(chain);
    const lines = await run(d, { dry: true, yes: false });
    expect(lines[1]).toBe("Dry run: buys one quote from 0x for 0.01 USDC on Base, and sends nothing else.");
    expect(d.quote).toHaveBeenCalledOnce();
    expect(chain.simulate).toHaveBeenCalledWith(expect.anything(), "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", BRAIN, { lend: BigInt(ETH_QUOTE.json.maxSellAmount) + parseEther("10") });
    expect(lines.some((line) => line.includes("Simulated on Robinhood Chain, as if the wallet held the ETH: it takes 0.07966 ETH"))).toBe(true);
    expect(lines.at(-2)).toMatch(new RegExp(`^${TAKER} holds 0.0002 ETH on Robinhood Chain, and needs about 0.0846\\d+ ETH: up to 0.084363 ETH for the swap, 0.0000\\d+ ETH for gas and 0.0003 ETH kept for the bridge's deposit.$`));
    expect(lines.at(-1)).toBe("Dry run: 0.01 USDC paid for the quote, nothing else sent.");
    expect(sent).toEqual([]);
    expect(bridged).toEqual([]);
  });

  it("asks before it buys and before it bridges, and does neither on a no", async () => {
    const answers = ["n"];
    const { chain, sent } = fakeChain();
    const { deps: d, bridged } = deps(chain);
    const ask = vi.fn(async () => answers.shift() ?? "n");
    expect((await run(d, { yes: false, ask })).at(-1)).toBe("Nothing sent. The quote's 0.01 USDC is spent.");
    expect(ask).toHaveBeenCalledWith("Buy 312,500 BRAIN for at most 0.084363 ETH? [y/N] ");
    expect(sent).toEqual([]);

    answers.push("y", "no");
    const lines = await run(d, { yes: false, ask });
    expect(ask).toHaveBeenLastCalledWith(`Move 312,500 BRAIN to BrainChain now with ${cli("bridge --stake 312500")}? [y/N] `);
    expect(lines.at(-1)).toBe(`The BRAIN stays on Robinhood Chain. ${cli("bridge --stake 312500")} moves it, then ${cli("join")} stakes it.`);
    expect(sent).toHaveLength(1);
    expect(bridged).toEqual([]);
  });

  it("approves exactly the most a USDG swap may take, to AllowanceHolder, and simulates the approval with it first", async () => {
    const { chain, sent } = fakeChain({ usdg: parseUnits("200", 6) });
    const { deps: d } = deps(chain, { fixture: USDG_QUOTE });
    await run(d, { pay: "usdg" });
    expect(sent).toEqual([`approve ${USDG} ${HOLDER} ${USDG_QUOTE.json.maxSellAmount}`, `swap ${HOLDER} 0 0x2213bc0b`]);
    expect(vi.mocked(chain.simulate).mock.calls.map((call) => call[3])).toEqual([{ approve: BigInt(USDG_QUOTE.json.maxSellAmount) }, {}]);
  });

  it("does not simulate a USDG swap the wallet cannot fund, and says what it lacks", async () => {
    const { chain } = fakeChain({ usdg: parseUnits("100", 6) });
    const { deps: d } = deps(chain, { fixture: USDG_QUOTE });
    const lines = await run(d, { pay: "usdg", dry: true });
    expect(chain.simulate).not.toHaveBeenCalled();
    expect(lines.some((line) => line.includes("Not simulated: the wallet holds 100 USDG of the 136.450213 USDG the swap may take."))).toBe(true);
    expect(lines).toContain(`${TAKER} holds 100 USDG on Robinhood Chain, and the swap may take up to 136.450213 USDG.`);
  });

  it("refuses a quote that fails a check, saying which and that the 0.01 USDC is spent", async () => {
    const { chain, sent } = fakeChain();
    const stale = deps(chain, { now: () => (ETH_QUOTE.created + 90) * 1000 }).deps;
    await expect(run(stale)).rejects.toThrow(/^0x's quote was refused before anything was signed: 0x signed 90 seconds ago, outside the 60 seconds .*\. The quote's 0\.01 USDC is spent; nothing else was sent\.$/);
    const counterfeit = deps({ ...chain, settlers: async () => ({ current: "0x4444444444444444444444444444444444444444" }) }).deps;
    await expect(run(counterfeit)).rejects.toThrow(/Settler 0xE8852602f84e04e284286d8Db01a41Edd0CCEFb0 is neither the registry's current Settler/);
    const other = deps(chain, { needs: async () => ({ need: STAKE + 1n, held: 0n }) }).deps;
    await expect(run(other)).rejects.toThrow(/the request 0x answered is not this trade: buyAmount=312500000000000000000000 where 312500000000000000000001 was meant/);
    expect(sent).toEqual([]);
  });

  it("looks up 0x's published keys when the quote is signed by one this build does not carry", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const created = ETH_QUOTE.created;
    const params = `("@status" "content-type" "content-digest" "@method";req "@authority";req "@path";req "@query";req);created=${created};keyid="0x-signing-key-next";alg="ed25519";tag="0x-swap-api"`;
    const base = [
      `"@status": 200`,
      `"content-type": ${ETH_QUOTE.headers["content-type"]}`,
      `"content-digest": ${ETH_QUOTE.headers["content-digest"]}`,
      `"@method";req: GET`,
      `"@authority";req: api.0x.org`,
      `"@path";req: /swap/allowance-holder/quote`,
      `"@query";req: ${new URL(ETH_QUOTE.url).search}`,
      `"@signature-params": ${params}`,
    ].join("\n");
    const rotated = { ...ETH_QUOTE, headers: { ...ETH_QUOTE.headers, "signature-input": `sig=${params}`, signature: `sig=:${sign(null, Buffer.from(base), privateKey).toString("base64")}:` } };
    const next = { keyid: "0x-signing-key-next", x: publicKey.export({ format: "jwk" }).x! };

    const { chain, sent } = fakeChain();
    const keys = vi.fn(async () => [next]);
    await run(deps(chain, { fixture: rotated, keys }).deps);
    expect(keys).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);

    await expect(run(deps(fakeChain().chain, { fixture: rotated, keys: async () => [] }).deps)).rejects.toThrow(/signed with key 0x-signing-key-next, which is not among the keys this check trusts/);
  });

  it("holds the route to the stake leg's loss limit, on the simulated spend", async () => {
    const { chain, sent } = fakeChain({ spent: parseEther("0.0825") });
    await expect(run(deps(chain).deps)).rejects.toThrow(
      "The route costs 9.54 USD more than the BRAIN is worth, 7.1%, more than the 6.69 this command accepts (5%, or 0.50 USD on a small buy). The quote's 0.01 USDC is spent; nothing else was sent.",
    );
    expect(sent).toEqual([]);
  });

  it("sends nothing when the swap fails in simulation, before or after the person answers", async () => {
    const failing = fakeChain({ fails: true });
    await expect(run(deps(failing.chain).deps)).rejects.toThrow("0x's transaction fails when simulated on Robinhood Chain: execution reverted. The quote's 0.01 USDC is spent; nothing else was sent.");
    expect(failing.sent).toEqual([]);

    const { chain, sent } = fakeChain({ usdg: parseUnits("200", 6) });
    let simulations = 0;
    chain.simulate = vi.fn(async () => {
      simulations += 1;
      if (simulations > 1) throw new Error("execution reverted");
      return { spent: BigInt(USDG_QUOTE.json.estimatedNetSellAmount), gained: STAKE };
    });
    await expect(run(deps(chain, { fixture: USDG_QUOTE }).deps, { pay: "usdg" })).rejects.toThrow(
      "0x's transaction fails when simulated on Robinhood Chain: execution reverted. Nothing was bought. The approval stays, and AllowanceHolder lets only this wallet's own transactions use it.",
    );
    expect(sent).toEqual([`approve ${USDG} ${HOLDER} ${USDG_QUOTE.json.maxSellAmount}`]);
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

  it("simulates in one eth_call, with the probe placed at the worker's own address and the approval made from it", async () => {
    const worker = privateKeyToAccount(`0x${"77".repeat(32)}`);
    const calls: { to: string; data: Hex; override: Record<string, { code?: string; balance?: string }> }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const { id, params } = JSON.parse(body) as { id: number; params: [{ to: string; data: Hex }, string, Record<string, { code?: string; balance?: string }>] };
        calls.push({ to: params[0].to, data: params[0].data, override: params[2] });
        const result = encodeFunctionResult({ abi: probeAbi, functionName: "probe", result: [5n, STAKE] });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const chain = createBuyChain({ ...MAINNET, bridge: { ...MAINNET.bridge!, rpc } }, worker);
      const swap = { to: HOLDER, data: ETH_QUOTE.json.transaction.data, value: 0n };
      expect(await chain.simulate(swap, USDG, BRAIN, { approve: 7n })).toEqual({ spent: 5n, gained: STAKE });
      expect(calls[0]!.to.toLowerCase()).toBe(worker.address.toLowerCase());
      expect(calls[0]!.override[worker.address]).toEqual({ code: PROBE_CODE });
      const { args } = decodeFunctionData({ abi: probeAbi, data: calls[0]!.data });
      expect(args).toEqual([USDG, BRAIN, 7n, HOLDER, 0n, ETH_QUOTE.json.transaction.data]);
      await chain.simulate({ ...swap, value: 1n }, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", BRAIN, { lend: 10n });
      expect(calls[1]!.override[worker.address]).toEqual({ code: PROBE_CODE, balance: "0xa" });
    } finally {
      server.close();
    }
  });
});
