import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { exit, exitFee, isSolanaAddress, RELAY_GAS_WEI, type ExitChain, type ExitTerms } from "./exit.js";
import { MAINNET, TESTNET } from "./network.js";
import { checkReturn, type RelayQuote } from "./relay.js";
import { split } from "./solana.js";

const DESK = "0x00000000000000000000000000000000000000d0" as Address;
const TOKEN = "0x00000000000000000000000000000000000000a3" as Address;
const terms: ExitTerms = { desk: DESK, token: TOKEN, payoutChainId: 46630, payoutToken: "0x00000000000000000000000000000000000000a1", feeBps: 50, minFeeUnits: "10000", minUnits: "1000000", maxUnits: "100000000" };
const TX = `0x${"ab".repeat(32)}` as Hex;
const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function fetchWith(records: unknown[]) {
  const queue = [...records];
  return vi.fn(async (url: string) => {
    if (url.endsWith("/exits")) return new Response(JSON.stringify(terms));
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ exits: [next] }));
  }) as unknown as typeof fetch;
}

function chainWith(balance: bigint, parentEth = 10n ** 16n) {
  const sent: { to: Address; amount: bigint }[] = [];
  const chain: ExitChain = {
    account: "0x0000000000000000000000000000000000000077",
    bountyBalance: vi.fn(async () => balance),
    sendToDesk: vi.fn(async (_token, to, amount) => {
      sent.push({ to, amount });
      return TX;
    }),
    parentEth: vi.fn(async () => parentEth),
    sendParent: vi.fn(async () => TX),
  };
  return { chain, sent };
}

const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
};

describe("exit", () => {
  it("sends the whole balance to the desk and reports the payout", async () => {
    const { chain, sent } = chainWith(5_000_000n);
    const { lines, log } = quiet();
    await exit(TESTNET, chain, { dry: false, log, fetchImpl: fetchWith([{ state: "waiting", reason: "x", net: "4975000", fee: "25000" }, { state: "paid", net: "4975000", fee: "25000", payoutTx: TX }]), sleep: async () => {} });
    expect(sent).toEqual([{ to: DESK, amount: 5_000_000n }]);
    expect(lines.at(-1)).toMatch(/Paid on the parent chain: 4\.975 tUSDG/);
  });

  it("refuses an exit below the minimum or above the balance, before sending", async () => {
    const { chain, sent } = chainWith(5_000_000n);
    await expect(exit(TESTNET, chain, { amount: "0.5", dry: false, log: () => {}, fetchImpl: fetchWith([]) })).rejects.toThrow(/at least 1 tUSDG/);
    await expect(exit(TESTNET, chain, { amount: "6", dry: false, log: () => {}, fetchImpl: fetchWith([]) })).rejects.toThrow(/less than 6 tUSDG/);
    expect(sent).toHaveLength(0);
  });

  it("keeps --to-solana to mainnet and checks the address and gas first", async () => {
    const { chain } = chainWith(5_000_000n);
    await expect(exit(TESTNET, chain, { toSolana: SOLANA, dry: true, log: () => {}, fetchImpl: fetchWith([]) })).rejects.toThrow(/mainnet only/);
    await expect(exit(MAINNET, chain, { toSolana: "not-an-address", dry: true, log: () => {}, fetchImpl: fetchWith([]) })).rejects.toThrow(/not a Solana address/);
    const broke = chainWith(5_000_000n, RELAY_GAS_WEI - 1n);
    await expect(exit(MAINNET, broke.chain, { toSolana: SOLANA, dry: true, log: () => {}, fetchImpl: fetchWith([]) })).rejects.toThrow(/ETH on Robinhood Chain/);
  });

  it("moves a paid exit on to Solana through Relay's steps", async () => {
    const { chain } = chainWith(5_000_000n);
    const quote: RelayQuote = { requestId: "0xrequest", steps: [{ id: "approve", items: [{ data: { to: DESK, data: "0x01", value: "0", chainId: 4663 } }] }, { id: "deposit", items: [{ data: { to: DESK, data: "0x02", value: "0", chainId: 4663 } }] }], inUsd: 4.97, outUsd: 4.95, outAmount: 4_950_000n, outFormatted: "4.95" };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/exits")) return new Response(JSON.stringify(terms));
      if (url.includes("/intents/status")) return new Response(JSON.stringify({ status: "success" }));
      return new Response(JSON.stringify({ exits: [{ state: "paid", net: "4975000", fee: "25000", payoutTx: TX }] }));
    }) as unknown as typeof fetch;
    const { lines, log } = quiet();
    await exit(MAINNET, chain, { toSolana: SOLANA, dry: false, log, fetchImpl, quote: vi.fn(async () => quote), sleep: async () => {} });
    expect(chain.sendParent).toHaveBeenCalledTimes(2);
    expect(lines.at(-1)).toMatch(/Arrived on Solana/);
  });
});

describe("pieces", () => {
  it("prices an exit like the desk", () => {
    expect(exitFee(10_000_000n, terms)).toBe(50_000n);
    expect(exitFee(1_000_000n, terms)).toBe(10_000n);
  });
  it("knows a Solana address", () => {
    expect(isSolanaAddress(SOLANA)).toBe(true);
    expect(isSolanaAddress("0x0000000000000000000000000000000000000077")).toBe(false);
  });
  it("refuses a Relay quote under 97% of its value", () => {
    expect(() => checkReturn({ inUsd: 10, outUsd: 9.6 })).toThrow(/96\.0%/);
    expect(() => checkReturn({ inUsd: 10, outUsd: 9.8 })).not.toThrow();
  });
  it("splits Solana USDC between gas and stake", () => {
    expect(split(10_000_000n, 2_000_000n, true)).toEqual({ gas: 2_000_000n, stake: 8_000_000n });
    expect(split(3_000_000n, 2_000_000n, false)).toEqual({ gas: 3_000_000n, stake: 0n });
    expect(() => split(2_000_000n, 2_000_000n, true)).toThrow(/more than the 2 USDC/);
  });
});
