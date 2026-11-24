import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASE, checkToBase, createBaseFunding, type BaseLeg } from "./base.js";
import { exit, moveToBase, type ExitChain, type ExitTerms } from "./exit.js";
import { fund } from "./fund.js";
import { cli } from "./invoked.js";
import { MAINNET, TESTNET } from "./network.js";
import type { RelayQuote } from "./relay.js";

const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
const WORKER = account.address;
const TO: Address = "0x1111111111111111111111111111111111111111";
const TX = `0x${"ab".repeat(32)}` as Hex;
const terms: ExitTerms = { desk: MAINNET.exitDesk, token: MAINNET.contracts.bountyToken, payoutChainId: 4663, payoutToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", feeBps: 50, minFeeUnits: "10000", minUnits: "1000000", maxUnits: "100000000" };

afterEach(() => {
  process.exitCode = 0;
});

describe("checkToBase", () => {
  it("takes a wallet's address on mainnet, and refuses a mistyped one, the zero address, USDC's contract and Relay's", () => {
    expect(checkToBase(MAINNET, TO)).toBe(TO);
    expect(checkToBase(MAINNET, WORKER.toLowerCase())).toBe(WORKER.toLowerCase());
    // One letter of a checksummed address in the wrong case: a typo the checksum catches.
    const mistyped = "0x97d558417c3D61f1074422AD843e1Db1E565b952";
    for (const bad of ["0x00", "0x0000000000000000000000000000000000000000", BASE.token, "0x4cD00E387622C35bDDB9b4c962C136462338BC31", mistyped]) {
      expect(() => checkToBase(MAINNET, bad), bad).toThrow(`"${bad}" is not the address of a wallet on Base, so USDC sent there could not be spent`);
    }
    expect(() => checkToBase(TESTNET, TO)).toThrow("--to-base is mainnet only: Relay connects Base with Robinhood Chain mainnet, not the testnets");
  });
});

const quote = (amount: bigint, out: string, id = "0xbase"): RelayQuote => ({ requestId: id, steps: [], inUsd: Number(amount) / 1e6, outUsd: Number(out), outAmount: 0n, outFormatted: out });

/** The Base leg of an exit: the worker's USDG on Robinhood Chain, Relay's quote for it, and what was sent. */
function leg(options: { held?: bigint[]; preview?: (amount: bigint) => Promise<RelayQuote>; send?: (q: RelayQuote) => Promise<string> } = {}) {
  const held = [...(options.held ?? [4_975_000n])];
  const sent: RelayQuote[] = [];
  const base: BaseLeg = {
    to: TO,
    held: vi.fn(async () => (held.length > 1 ? held.shift()! : held[0]!)),
    preview: vi.fn(options.preview ?? (async (amount: bigint) => quote(amount, "4.95"))),
    send: vi.fn(
      options.send ??
        (async (q: RelayQuote) => {
          sent.push(q);
          return `Relay request ${q.requestId}`;
        }),
    ),
  };
  return { base, sent };
}

function chain() {
  const sent: bigint[] = [];
  const c: ExitChain = {
    account: WORKER,
    bountyBalance: vi.fn(async () => 5_000_000n),
    unmined: vi.fn(async () => 0),
    sendToDesk: vi.fn(async (_token, _desk, amount) => {
      sent.push(amount);
      return TX;
    }),
  };
  return { c, sent };
}

const desk = (records: unknown[]) => {
  const queue = [...records];
  return vi.fn(async (url: string) => {
    if (url.endsWith("/exits")) return new Response(JSON.stringify(terms));
    return new Response(JSON.stringify({ exits: [queue.length > 1 ? queue.shift() : queue[0]] }));
  }) as unknown as typeof fetch;
};
const paid = { state: "paid", net: "4975000", fee: "25000", payoutTx: TX };

describe("exit --to-base", () => {
  it("prices the move to Base before anything is sent, and a dry run stops there", async () => {
    const { base, sent } = leg();
    const { c } = chain();
    const lines: string[] = [];
    await exit(MAINNET, c, { toBase: base, dry: true, log: (l) => lines.push(l), fetchImpl: desk([]) });
    expect(lines).toEqual([
      `Exit 5.00 USDG from BrainChain: 4.975 USDG after a 0.025 USDG fee is paid to this wallet on Robinhood Chain, then moved through Relay as USDC to ${TO} on Base, less Relay's own fee.`,
      "Relay quotes 4.95 USDC on Base for it now. It prices the move again once the desk has paid; one that would then cost more than 3% (or 0.50 USD) is not made, and the USDG stays in this wallet on Robinhood Chain.",
      "Dry run, nothing sent.",
    ]);
    expect(base.preview).toHaveBeenCalledWith(4_975_000n);
    expect(c.sendToDesk).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("sends nothing to the desk when Relay's price for the move is refused", async () => {
    const { base } = leg({ preview: async () => Promise.reject(new Error("Relay would keep 0.60 USD of 4.98, more than the 0.50 this command accepts")) });
    const { c } = chain();
    await expect(exit(MAINNET, c, { toBase: base, dry: false, log: () => {}, fetchImpl: desk([paid]) })).rejects.toThrow("Relay would keep 0.60 USD");
    expect(c.sendToDesk).not.toHaveBeenCalled();
  });

  it("moves exactly what the desk paid on to Base, once the wallet shows it, with a quote made after the payout", async () => {
    const { base, sent } = leg({ held: [0n, 0n, 4_975_000n] });
    const { c, sent: toDesk } = chain();
    const lines: string[] = [];
    await exit(MAINNET, c, { toBase: base, dry: false, log: (l) => lines.push(l), fetchImpl: desk([paid]), sleep: async () => {} });
    expect(toDesk).toEqual([5_000_000n]);
    expect(base.preview).toHaveBeenCalledTimes(2);
    expect(sent.map((q) => q.inUsd)).toEqual([4.975]);
    expect(lines.slice(-2)).toEqual([`Paid on the parent chain: 4.975 USDG (${TX}).`, `Paid on Base: 4.95 USDC to ${TO} (Relay request 0xbase).`]);
    expect(process.exitCode).toBe(0);
  });

  it("leaves the exit paid on Robinhood Chain when the move cannot be made, says how to finish it, and exits 1", async () => {
    let calls = 0;
    const { base } = leg({ preview: async (amount) => (calls++ === 0 ? quote(amount, "4.95") : Promise.reject(new Error("Relay would keep 0.60 USD of 4.98, more than the 0.50 this command accepts (3%, or 0.50 USD on a small move). Nothing was sent; try again later."))) });
    const { c } = chain();
    const lines: string[] = [];
    await exit(MAINNET, c, { toBase: base, dry: false, log: (l) => lines.push(l), fetchImpl: desk([paid]), sleep: async () => {} });
    expect(lines.at(-1)).toBe(
      `Not moved on to Base: Relay would keep 0.60 USD of 4.98, more than the 0.50 this command accepts (3%, or 0.50 USD on a small move). Nothing was sent; try again later. If the 4.975 USDG is still in this wallet on Robinhood Chain, ${cli(`exit --to-base ${TO} --from-robinhood --amount 4.975`)} moves it.`,
    );
    expect(process.exitCode).toBe(1);

    const short = leg({ held: [1_000_000n] });
    const second = chain();
    const said: string[] = [];
    await exit(MAINNET, second.c, { toBase: short.base, dry: false, log: (l) => said.push(l), fetchImpl: desk([paid]), sleep: async () => {} });
    expect(said.at(-1)).toMatch(/^Not moved on to Base: the wallet shows 1\.00 USDG on Robinhood Chain, less than the 4\.975 the desk reports paid\./);
    expect(short.sent).toEqual([]);
  });

  it("moves nothing on when the desk returns the exit or pays it some other way", async () => {
    const { base, sent } = leg();
    const { c } = chain();
    await exit(MAINNET, c, { toBase: base, dry: false, log: () => {}, fetchImpl: desk([{ state: "returned", net: "4975000", fee: "25000", reason: "over the daily limit", returnTx: TX }]), sleep: async () => {} });
    expect(sent).toEqual([]);
    expect(base.preview).toHaveBeenCalledTimes(1);
  });
});

describe("exit --to-base --from-robinhood", () => {
  it("moves USDG the wallet holds on Robinhood Chain, all of it without --amount, and no more than it holds", async () => {
    const lines: string[] = [];
    const all = leg({ held: [7_000_000n] });
    await moveToBase(MAINNET, all.base, { dry: false, log: (l) => lines.push(l) });
    expect(all.base.preview).toHaveBeenCalledWith(7_000_000n);
    expect(lines).toEqual([`Move 7.00 USDG from Robinhood Chain to ${TO} on Base: Relay quotes 4.95 USDC.`, `Paid on Base: 4.95 USDC to ${TO} (Relay request 0xbase).`]);
    const dry = leg({ held: [7_000_000n] });
    await moveToBase(MAINNET, dry.base, { amount: "2", dry: true, log: () => {} });
    expect(dry.sent).toEqual([]);
    await expect(moveToBase(MAINNET, leg({ held: [1_000_000n] }).base, { amount: "2", dry: false, log: () => {} })).rejects.toThrow("The wallet holds 1.00 USDG on Robinhood Chain, less than 2.00 USDG");
    await expect(moveToBase(MAINNET, leg({ held: [0n] }).base, { dry: false, log: () => {} })).rejects.toThrow("The wallet holds no USDG on Robinhood Chain");
  });
});

describe("fund --from-base", () => {
  it("names Base, asks for no ETH there, and follows each move by its Relay request", async () => {
    const funding = createBaseFunding(account, 4663);
    expect(funding.chain).toBe("Base");
    expect(funding.owner).toBe(WORKER);
    expect(await funding.feeShortfall()).toBeUndefined();

    const lines: string[] = [];
    let eth = 0n;
    await fund({
      funding: {
        ...funding,
        usdcBalance: async () => 3_000_000n,
        preview: async (_currency, amount) => ({ ...quote(amount, "1.98", "0xgas"), outAmount: parseEther("0.001"), outFormatted: "0.001" }),
        send: async (q) => {
          eth += parseEther("0.001");
          return `Relay request ${q.requestId}`;
        },
      },
      worker: WORKER,
      usdc: "3",
      stake: false,
      dry: false,
      log: (l) => lines.push(l),
      parentEth: async () => eth,
      parentStake: async () => 0n,
      bridgeOn: async (_asset, amount) => {
        eth -= amount;
      },
      sleep: async () => {},
    });
    expect(lines[0]).toBe(`From ${WORKER} on Base: 2 USDC to ETH for gas, for ${WORKER}. The other 1 USDC stays on Base.`);
    expect(lines).toContain("ETH arrived on Robinhood Chain: 0.001 ETH (Relay request 0xgas).");
    expect(lines.at(-1)).toContain("Done.");
  });

  it("says what the Base wallet lacks after the quote", async () => {
    const funding = createBaseFunding(account, 4663);
    const run = fund({
      funding: { ...funding, usdcBalance: async () => 0n, preview: async (_c, amount) => quote(amount, "1.98") },
      worker: WORKER,
      usdc: "5",
      stake: false,
      dry: true,
      log: () => {},
      parentEth: async () => 0n,
      parentStake: async () => 0n,
      bridgeOn: async () => {},
    });
    await expect(run).rejects.toThrow(`The Base wallet ${WORKER} holds 0 USDC. Without --stake this run spends only the 2 USDC it turns into ETH for gas, and the wallet holds less than that.\nDry run, nothing sent.`);
  });
});
