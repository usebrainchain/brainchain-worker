import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { decodeFunctionData, erc20Abi } from "viem";

import { exit, exitCalldata, exitFee, isSolanaAddress, type ExitChain, type ExitTerms } from "./exit.js";
import { MAINNET, TESTNET } from "./network.js";
import { checkReturn } from "./relay.js";
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

function chainWith(balance: bigint) {
  const sent: { to: Address; amount: bigint; solana?: string }[] = [];
  const chain: ExitChain = {
    account: "0x0000000000000000000000000000000000000077",
    bountyBalance: vi.fn(async () => balance),
    sendToDesk: vi.fn(async (_token, to, amount, solana) => {
      sent.push({ to, amount, ...(solana ? { solana } : {}) });
      return TX;
    }),
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

  it("keeps --to-solana to mainnet and to real Solana addresses", async () => {
    const { chain } = chainWith(5_000_000n);
    await expect(exit(TESTNET, chain, { toSolana: SOLANA, dry: true, log: () => {}, fetchImpl: fetchWith([]) })).rejects.toThrow(/mainnet only/);
    await expect(exit(MAINNET, chain, { toSolana: "not-an-address", dry: true, log: () => {}, fetchImpl: fetchWith([]) })).rejects.toThrow(/not a Solana address/);
  });

  it("names the Solana address in the transfer and reports the desk's payout there", async () => {
    const { chain, sent } = chainWith(5_000_000n);
    const { lines, log } = quiet();
    await exit(MAINNET, chain, { toSolana: SOLANA, dry: false, log, fetchImpl: fetchWith([{ state: "paid", net: "4975000", fee: "25000", payoutTx: TX, solana: SOLANA, relayRequest: "0xreq" }]), sleep: async () => {} });
    expect(sent).toEqual([{ to: DESK, amount: 5_000_000n, solana: SOLANA }]);
    expect(lines.at(-1)).toMatch(/Paid on Solana: 4\.975 USDG as USDC to 7xKX/);
  });
});

describe("pieces", () => {
  it("prices an exit like the desk", () => {
    expect(exitFee(10_000_000n, terms)).toBe(50_000n);
    expect(exitFee(1_000_000n, terms)).toBe(10_000n);
  });
  it("puts the Solana address after a plain transfer's arguments", () => {
    const plain = exitCalldata(DESK, 5n);
    expect(decodeFunctionData({ abi: erc20Abi, data: plain }).args).toEqual([DESK, 5n]);
    const named = exitCalldata(DESK, 5n, SOLANA);
    expect(named.startsWith(plain)).toBe(true);
    expect((named.length - plain.length) / 2).toBe(32);
  });
  it("knows a Solana address", () => {
    expect(isSolanaAddress(SOLANA)).toBe(true);
    expect(isSolanaAddress("0x0000000000000000000000000000000000000077")).toBe(false);
  });
  it("refuses a Relay quote that loses more than 3%, or 0.50 USD on a small move", () => {
    expect(() => checkReturn({ inUsd: 100, outUsd: 95 })).toThrow(/keep 5\.00 USD of 100\.00, more than the 3\.00/);
    expect(() => checkReturn({ inUsd: 100, outUsd: 97.5 })).not.toThrow();
    expect(() => checkReturn({ inUsd: 3, outUsd: 2.87 })).not.toThrow();
    expect(() => checkReturn({ inUsd: 3, outUsd: 2.4 })).toThrow(/0\.50/);
  });
  it("splits Solana USDC between gas and stake", () => {
    expect(split(10_000_000n, 2_000_000n, true)).toEqual({ gas: 2_000_000n, stake: 8_000_000n });
    expect(split(3_000_000n, 2_000_000n, false)).toEqual({ gas: 3_000_000n, stake: 0n });
    expect(() => split(2_000_000n, 2_000_000n, true)).toThrow(/more than the 2 USDC/);
  });
});
