import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, parseAbi, parseEther, parseTransaction, parseUnits, toEventSelector, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { bridge, createBridgeChain, DepositSent, stakeInFlight, stakeProblem, unarrived, type ActiveSet, type Asset, type BridgeChain, type StakeDeposit } from "./bridge.js";
import { cli } from "./invoked.js";
import { MAINNET, TESTNET } from "./network.js";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000C1";
const TX: Hex = `0x${"fe".repeat(32)}`;
const { taskBoard, staking, bonds, executor, registry, log } = MAINNET.contracts;
/** The active set as BrainChain's service names it once set 3.6.0 is active: this release's pins. */
const PINNED: ActiveSet = { contracts: { TaskBoard: taskBoard, WorkerStaking: staking, ProposalBonds: bonds, DecisionExecutor: executor, ModelRegistry: registry, DecisionLog: log } };

function fakeChain(options: { eth?: bigint; stake?: bigint; bounty?: bigint; cost?: bigint; staked?: Address } = {}) {
  const sent: string[] = [];
  const chain: BridgeChain = {
    account: ACCOUNT,
    unmined: vi.fn(async () => 0),
    parentEth: vi.fn(async () => options.eth ?? parseEther("0.01")),
    tokenBalance: vi.fn(async (asset: Exclude<Asset, "eth">) => (asset === "stake" ? (options.stake ?? parseEther("2000000")) : (options.bounty ?? parseUnits("50", 6)))),
    arrivalCost: vi.fn(async () => options.cost ?? parseEther("0.0003")),
    depositEth: vi.fn(async (amount: bigint) => {
      sent.push(`eth ${amount}`);
      return TX;
    }),
    depositToken: vi.fn(async (asset: Exclude<Asset, "eth">, amount: bigint, value: bigint, onSent?: (hash: Hex) => void) => {
      sent.push(`${asset} ${amount} value ${value}`);
      onSent?.(TX);
      return TX;
    }),
    stakeTokens: vi.fn(async () => ({ bridged: MAINNET.contracts.stakeToken, staked: options.staked ?? MAINNET.contracts.stakeToken })),
    activeSet: vi.fn(async () => PINNED),
    stakeDeposits: vi.fn(async () => ({ sent: [], arrived: [] })),
    transactionState: vi.fn(async () => "mined" as const),
  };
  return { chain, sent };
}

async function run(chain: BridgeChain, asset: Asset, amount: string, dry = false, network = MAINNET) {
  const lines: string[] = [];
  await bridge(network, chain, { asset, amount, dry, log: (line) => lines.push(line) });
  return lines;
}

describe("bridge", () => {
  it("deposits ETH through the inbox and says when it arrives", async () => {
    const { chain, sent } = fakeChain();
    const lines = await run(chain, "eth", "0.001");
    expect(sent).toEqual([`eth ${parseEther("0.001")}`]);
    expect(lines).toEqual([
      `bridging 0.001 ETH from Robinhood Chain to ${ACCOUNT} on BrainChain`,
      `sent, arrives on BrainChain in about a minute: ${TX}`,
    ]);
  });

  it("deposits the stake token with the ETH its arrival costs", async () => {
    const { chain, sent } = fakeChain({ cost: parseEther("0.0003") });
    const lines = await run(chain, "stake", "1250000");
    expect(sent).toEqual([`stake ${parseEther("1250000")} value ${parseEther("0.0003")}`]);
    expect(lines[0]).toBe(
      `bridging 1,250,000 BRAIN from Robinhood Chain to ${ACCOUNT} on BrainChain (sending 0.0003 ETH for its arrival, the unused part refunded there; with gas, the wallet needs about 0.0004 ETH on Robinhood Chain)`,
    );
  });

  it("takes bounty amounts in 6 decimals and sends nothing on a dry run", async () => {
    const { chain, sent } = fakeChain();
    const lines = await run(chain, "bounty", "12.5", true);
    expect(sent).toEqual([]);
    expect(lines[0]).toContain("bridging 12.5 USDG");
    expect(lines[1]).toBe("dry run: nothing sent");
  });

  it("says exactly what the wallet lacks, and sends nothing", async () => {
    const short = fakeChain({ stake: parseEther("1000") });
    await expect(run(short.chain, "stake", "1250000")).rejects.toThrow(`${ACCOUNT} holds 1,000 BRAIN on Robinhood Chain, 1,249,000 short of 1,250,000 BRAIN`);
    const noGas = fakeChain({ eth: parseEther("0.0001") });
    await expect(run(noGas.chain, "bounty", "1")).rejects.toThrow(/holds 0.0001 ETH on Robinhood Chain; about 0.0004 ETH is needed/);
    await expect(run(noGas.chain, "eth", "0.001")).rejects.toThrow(/0.001 ETH plus gas is needed/);
    expect(short.sent).toEqual([]);
    expect(noGas.sent).toEqual([]);
  });

  it("prints the whole plan on a dry run for an empty wallet, the ETH the deposit needs included, then every shortfall", async () => {
    const empty = fakeChain({ eth: 0n, bounty: 0n });
    const lines: string[] = [];
    const error = await bridge(MAINNET, empty.chain, { asset: "bounty", amount: "5", dry: true, log: (line) => lines.push(line) }).catch((e: unknown) => (e as Error).message);
    expect(lines).toEqual([
      `bridging 5 USDG from Robinhood Chain to ${ACCOUNT} on BrainChain (sending 0.0003 ETH for its arrival, the unused part refunded there; with gas, the wallet needs about 0.0004 ETH on Robinhood Chain)`,
    ]);
    expect(error).toBe(
      `${ACCOUNT} holds 0 USDG on Robinhood Chain, 5 short of 5 USDG\n` +
        `${ACCOUNT} holds 0 ETH on Robinhood Chain; about 0.0004 ETH is needed to pay the deposit's arrival and gas. ${MAINNET.bridge!.gas}\n` +
        "dry run: nothing sent",
    );
    const noEth = fakeChain({ eth: 0n });
    const ethLines: string[] = [];
    await expect(bridge(MAINNET, noEth.chain, { asset: "eth", amount: "0.001", dry: true, log: (line) => ethLines.push(line) })).rejects.toThrow(/0\.001 ETH plus gas is needed\. .*\ndry run: nothing sent$/s);
    expect(ethLines).toEqual([`bridging 0.001 ETH from Robinhood Chain to ${ACCOUNT} on BrainChain`]);
    expect([...empty.sent, ...noEth.sent]).toEqual([]);
  });

  it("will not send while an earlier transaction of the wallet is unmined, since it may be a deposit", async () => {
    for (const asset of ["eth", "stake"] as const) {
      const { chain, sent } = fakeChain();
      vi.mocked(chain.unmined).mockResolvedValue(1);
      await expect(run(chain, asset, "0.001")).rejects.toThrow(
        "This wallet has a transaction on Robinhood Chain that is not mined yet, which may be an earlier deposit, and another run would send another. Nothing was sent; run bridge again once it is mined.",
      );
      expect(sent).toEqual([]);
    }
  });

  it("refuses a token the network mints on BrainChain only", async () => {
    const { chain } = fakeChain();
    await expect(run(chain, "eth", "0.001", true, TESTNET)).resolves.toBeDefined();
    (chain.tokenBalance as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("BrainChain testnet's stake token is not bridged from Robinhood Chain testnet"));
    await expect(run(chain, "stake", "1", false, TESTNET)).rejects.toThrow(/not bridged/);
  });
});

describe("depositToken", () => {
  const account = privateKeyToAccount(`0x${"4f".repeat(32)}`);
  const GATEWAY: Address = "0x00000000000000000000000000000000000000A7";
  const GAS_PRICE = 100_000_000n;
  /** What the deposit's arrival costs on BrainChain at twice GAS_PRICE, for its 300,000 gas. */
  const ARRIVAL = 300_000n * GAS_PRICE * 2n;
  const routerAbi = parseAbi(["function outboundTransferCustomRefund(address token, address refundTo, address to, uint256 amount, uint256 maxGas, uint256 gasPriceBid, bytes data) payable returns (bytes)"]);
  const word = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);

  /** A deposit against one fake RPC standing in for both chains, with no allowance set; returns what it sent. */
  async function deposit(value: bigint, options: { unconfirmed?: boolean } = {}) {
    const raw: Hex[] = [];
    const answer = (method: string, params: unknown[]): unknown => {
      switch (method) {
        case "eth_chainId":
          return `0x${MAINNET.bridge!.chainId.toString(16)}`;
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas":
          return `0x${GAS_PRICE.toString(16)}`;
        case "eth_call": {
          const { data } = params[0] as { data: Hex };
          return data.startsWith(toFunctionSelector("getGateway(address)")) ? encodeAbiParameters([{ type: "address" }], [GATEWAY]) : word(0n);
        }
        case "eth_getBlockByNumber":
          return { number: "0x10", hash: TX, parentHash: TX, timestamp: "0x1", baseFeePerGas: "0x5f5e100", transactions: [], logsBloom: null, nonce: null };
        case "eth_getTransactionCount":
          return `0x${raw.length.toString(16)}`;
        case "eth_estimateGas":
          return "0x30000";
        case "eth_blockNumber":
          return "0x10";
        case "eth_sendRawTransaction":
          raw.push((params as Hex[])[0]!);
          return `0x${raw.length.toString(16).padStart(64, "0")}`;
        case "eth_getTransactionByHash":
          return null;
        case "eth_getTransactionReceipt":
          // The approval is the first transaction and the deposit the second.
          if (options.unconfirmed && params[0] === `0x${"2".padStart(64, "0")}`) return null;
          return { status: "0x1", blockNumber: "0x10", blockHash: TX, transactionHash: params[0], transactionIndex: "0x0", from: account.address, to: GATEWAY, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", contractAddress: null };
        default:
          return undefined;
      }
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        res.setHeader("content-type", "application/json");
        const result = answer(method, params);
        res.end(JSON.stringify({ jsonrpc: "2.0", id, ...(result === undefined ? { error: { code: -32601, message: `${method} not found` } } : { result }) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const network = { ...MAINNET, rpc: url, bridge: { ...MAINNET.bridge!, rpc: url } };
      const outcome = await createBridgeChain(network, account, 50).depositToken("stake", 5n, value).catch((error: Error) => error);
      return { outcome, raw };
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  const moved = "The gas price on BrainChain moved after this deposit was priced, so the ETH set aside no longer pays for its arrival. Nothing was sent. Run the command again.";

  it.each([
    ["no longer covers", ARRIVAL - 1n],
    ["covers only", ARRIVAL],
  ])("sends nothing, not even the approval, when the ETH set aside %s the arrival at the current gas price", async (_, value) => {
    const { outcome, raw } = await deposit(value);
    expect((outcome as Error).message).toBe(moved);
    expect(raw).toEqual([]);
  });

  it("approves and then deposits, the rest of the ETH paying for submission", async () => {
    const submission = 777n;
    const { raw } = await deposit(ARRIVAL + submission);
    expect(raw).toHaveLength(2);
    const sent = parseTransaction(raw[1]!);
    expect(sent.value).toBe(ARRIVAL + submission);
    const { args } = decodeFunctionData({ abi: routerAbi, data: sent.data! });
    expect(args[5]).toBe(GAS_PRICE * 2n);
    expect(decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], args[6])[0]).toBe(submission);
  });

  it("names a deposit that was sent and not confirmed, and that it can still land", async () => {
    const { outcome, raw } = await deposit(ARRIVAL + 777n, { unconfirmed: true });
    expect(raw).toHaveLength(2);
    expect(outcome).toBeInstanceOf(DepositSent);
    expect((outcome as Error).message).toMatch(
      new RegExp(`^The deposit was sent on Robinhood Chain \\(0x0{63}2\\) and could not be confirmed \\(.+\\)\\. It can still land, so check it before running bridge again: another run sends another deposit\\.$`),
    );
  });
});

describe("the stake token", () => {
  const OLD: Address = "0x3367085Eb6C79BfB0fCa4f1433ec77bFA8CB8a37";

  it("bridges only when the token this release names bridges to the one the staking contract takes", async () => {
    expect(await stakeProblem(MAINNET, fakeChain().chain)).toBeUndefined();
    const { chain, sent } = fakeChain({ staked: OLD });
    await expect(run(chain, "stake", "1000")).rejects.toThrow(
      `This release of brainchain-worker names 0x42b96dbc55e79E930d866c1eE486A342366546BC as BRAIN on Robinhood Chain, which the bridge turns into ${MAINNET.contracts.stakeToken} on BrainChain, ` +
        `and the staking contract takes ${OLD}. Buying or bridging it would bring a token nothing stakes. Update with npx brainchain-worker@latest. Nothing was sent.`,
    );
    await run(chain, "bounty", "5");
    expect(sent).toEqual([expect.stringMatching(/^bounty /)]);
  });

  it("refuses when the staking contract cannot be read, rather than bridge unchecked", async () => {
    const { chain, sent } = fakeChain();
    chain.stakeTokens = vi.fn(async () => {
      throw new Error("rpc.usebrainchain.com did not answer");
    });
    await expect(run(chain, "stake", "1000")).rejects.toThrow(/Could not read which token the staking contract takes \(rpc.usebrainchain.com did not answer\), so the stake token was not checked\. Nothing was sent\./);
    expect(sent).toEqual([]);
  });

  it("reads the router's mapping on the parent chain and the staking contract's token on BrainChain", async () => {
    const calls: { chain: string; to: string; data: string }[] = [];
    const server = (name: string, answer: (data: string) => string) =>
      createServer((request, response) => {
        let body = "";
        request.on("data", (c) => (body += c));
        request.on("end", () => {
          const { id, params } = JSON.parse(body) as { id: number; params: [{ to: string; data: string }] };
          calls.push({ chain: name, ...params[0] });
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: answer(params[0].data) }));
        });
      });
    const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const parent = server("parent", () => word(MAINNET.contracts.stakeToken));
    const child = server("child", () => word(MAINNET.contracts.stakeToken));
    await Promise.all([parent, child].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
    const url = (s: typeof parent) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const network = { ...MAINNET, rpc: url(child), bridge: { ...MAINNET.bridge!, rpc: url(parent) } };
      const chain = createBridgeChain(network, privateKeyToAccount(`0x${"11".repeat(32)}`));
      expect(await chain.stakeTokens()).toEqual({ bridged: MAINNET.contracts.stakeToken, staked: MAINNET.contracts.stakeToken });
      const routerCall = calls.find((c) => c.chain === "parent")!;
      expect(routerCall.to.toLowerCase()).toBe(MAINNET.bridge!.router.toLowerCase());
      expect(routerCall.data).toBe(`${toFunctionSelector("calculateL2TokenAddress(address)")}${word(MAINNET.bridge!.tokens!.stake!).slice(2)}`);
      const stakingCall = calls.find((c) => c.chain === "child")!;
      expect([stakingCall.to.toLowerCase(), stakingCall.data]).toEqual([MAINNET.contracts.staking.toLowerCase(), toFunctionSelector("token()")]);
    } finally {
      parent.close();
      child.close();
    }
  });
});

describe("the release BrainChain names active", () => {
  const OTHER: Address = "0x00000000000000000000000000000000000000B2";

  it("refuses a release BrainChain has moved past, and says to update", async () => {
    const { chain, sent } = fakeChain();
    chain.activeSet = vi.fn(async () => ({ contracts: { ...PINNED.contracts, TaskBoard: OTHER, WorkerStaking: OTHER } }));
    await expect(run(chain, "stake", "1000")).rejects.toThrow(
      `BrainChain names ${OTHER} as the active TaskBoard, and this release of brainchain-worker pins ${taskBoard}, so it is for an earlier set. Update with npx brainchain-worker@latest. Nothing was sent.`,
    );
    expect(sent).toEqual([]);
  });

  it("refuses while BrainChain still names the set before this release's", async () => {
    const { chain, sent } = fakeChain();
    const previous = MAINNET.retired![0]!;
    chain.activeSet = vi.fn(async () => ({ contracts: { ...PINNED.contracts, TaskBoard: previous.taskBoard, WorkerStaking: previous.staking } }));
    expect(await stakeProblem(MAINNET, chain)).toBe(
      "BrainChain still names set 3.5.0 active, and this release of brainchain-worker stakes on the set after it, which is not active yet. Run it again once BrainChain has switched",
    );
    await expect(run(chain, "stake", "1000")).rejects.toThrow(/Nothing was sent\.$/);
    expect(sent).toEqual([]);
  });

  it("says so when the service cannot be read, and holds the token to the chain alone", async () => {
    const { chain, sent } = fakeChain();
    chain.activeSet = vi.fn(async () => Promise.reject(new Error("https://brain.usebrainchain.com/network.json answered 503")));
    const lines = await run(chain, "stake", "1000");
    expect(lines[0]).toBe(
      "Could not read BrainChain's active contracts (https://brain.usebrainchain.com/network.json answered 503); checking the stake token on chain instead.",
    );
    expect(sent).toHaveLength(1);
    const old = fakeChain({ staked: "0x3367085Eb6C79BfB0fCa4f1433ec77bFA8CB8a37" });
    old.chain.activeSet = chain.activeSet;
    await expect(run(old.chain, "stake", "1000")).rejects.toThrow(/the staking contract takes 0x3367085Eb6C79BfB0fCa4f1433ec77bFA8CB8a37/);
    expect(old.sent).toEqual([]);
  });

  it("reads the active set from the service's network.json, for this chain only", async () => {
    const manifest = (chainId: number) => ({ manifest: { chainId, activeSet: { fromBlock: 2787, contracts: { ...PINNED.contracts, Extra: 7 } } }, signed: "", signature: "0x" });
    const asked: string[] = [];
    const fetcher = (body: unknown, status = 200) =>
      vi.fn(async (url: string | URL | Request) => {
        asked.push(String(url));
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    expect(await createBridgeChain(MAINNET, account, 50, fetcher(manifest(MAINNET.chainId))).activeSet()).toEqual(PINNED);
    expect(asked).toEqual(["https://brain.usebrainchain.com/network.json"]);
    await expect(createBridgeChain(MAINNET, account, 50, fetcher(manifest(TESTNET.chainId))).activeSet()).rejects.toThrow("https://brain.usebrainchain.com/network.json names no active set for BrainChain");
    await expect(createBridgeChain(MAINNET, account, 50, fetcher({}, 502)).activeSet()).rejects.toThrow("answered 502");
  });
});

describe("a stake buy in flight", () => {
  const NOW = 1_800_000_000;
  const deposit = (tx: string, at: number, amount = parseEther("312500")): StakeDeposit => ({ tx: `0x${tx.repeat(64)}` as Hex, amount, at });
  const chainWith = (options: { unmined?: number; deposits?: { sent: StakeDeposit[]; arrived: StakeDeposit[] } | Error; state?: "mined" | "pending" | "unknown" } = {}) => ({
    unmined: vi.fn(async () => options.unmined ?? 0),
    stakeDeposits: vi.fn(async () => {
      if (options.deposits instanceof Error) throw options.deposits;
      return options.deposits ?? { sent: [], arrived: [] };
    }),
    transactionState: vi.fn(async () => options.state ?? ("mined" as const)),
  });

  it("is nothing when every deposit of the last day has arrived and nothing is unmined", async () => {
    const sent = [deposit("1", NOW - 3_600), deposit("2", NOW - 600)];
    const arrived = [deposit("a", NOW - 3_540), deposit("b", NOW - 540)];
    expect(await stakeInFlight(MAINNET, chainWith({ deposits: { sent, arrived } }), {}, NOW)).toBeUndefined();
  });

  it("names a deposit that has not arrived on BrainChain", async () => {
    const sent = [deposit("1", NOW - 3_600), deposit("2", NOW - 120)];
    // An arrival older than a deposit cannot be it, and each arrival accounts for one deposit.
    const arrived = [deposit("a", NOW - 7_200), deposit("b", NOW - 3_500)];
    expect(await stakeInFlight(MAINNET, chainWith({ deposits: { sent, arrived } }), {}, NOW)).toBe(
      `A deposit of 312,500 BRAIN from this wallet, sent 2 minutes ago (${sent[1]!.tx}), has not arrived on BrainChain yet, and buying now would buy it again. ` +
        `Deposits arrive in about a minute: run ${cli("buy-stake")} again once ${cli("status")} shows it`,
    );
  });

  it("matches deposits to arrivals by amount, oldest first, each arrival once", () => {
    const a = deposit("1", 100, 5n);
    const b = deposit("2", 200, 5n);
    const c = deposit("3", 300, 7n);
    expect(unarrived([c, b, a], [deposit("x", 150, 5n)])).toEqual([b, c]);
    expect(unarrived([a, b], [deposit("x", -100, 5n), deposit("y", 250, 5n)])).toEqual([b]);
    expect(unarrived([a], [deposit("x", 100 - 120, 5n)])).toEqual([]);
  });

  it("names an unmined transaction, and the swap or deposit it may be", async () => {
    const saved = { swap: { tx: TX, at: NOW - 90 }, deposit: { tx: `0x${"cd".repeat(32)}` as Hex, amount: parseEther("312500"), at: NOW - 600 } };
    expect(await stakeInFlight(MAINNET, chainWith({ unmined: 1 }), saved, NOW)).toBe(
      `This wallet has a transaction on Robinhood Chain that is not mined yet, which may be the swap it sent a minute ago (${TX}), and buying now could buy the BRAIN twice. Run ${cli("buy-stake")} again once it is mined`,
    );
    expect(await stakeInFlight(MAINNET, chainWith({ unmined: 2 }), {}, NOW)).toMatch(/^This wallet has a transaction on Robinhood Chain that is not mined yet, and buying now/);
  });

  it("names a swap sent in the last ten minutes that the RPC does not know yet, and not one it has mined or one older", async () => {
    const saved = { swap: { tx: TX, at: NOW - 240 } };
    expect(await stakeInFlight(MAINNET, chainWith({ state: "unknown" }), saved, NOW)).toBe(
      `The swap this wallet sent 4 minutes ago (${TX}) is not on Robinhood Chain yet, and buying now could buy the BRAIN twice. Run ${cli("buy-stake")} again once it is mined, or in 6 minutes if it never is`,
    );
    expect(await stakeInFlight(MAINNET, chainWith({ state: "mined" }), saved, NOW)).toBeUndefined();
    expect(await stakeInFlight(MAINNET, chainWith({ state: "unknown" }), { swap: { tx: TX, at: NOW - 600 } }, NOW)).toBeUndefined();
  });

  it("refuses when the deposits cannot be read and a deposit was saved in the last day, and not otherwise", async () => {
    const failing = chainWith({ deposits: new Error("query returned more than 10000 results") });
    const saved = { deposit: { tx: TX, amount: parseEther("1000"), at: NOW - 30 } };
    expect(await stakeInFlight(MAINNET, failing, saved, NOW)).toBe(
      `Could not check whether the deposit of 1,000 BRAIN sent less than a minute ago (${TX}) has arrived on BrainChain (query returned more than 10000 results), and buying before it does could buy it twice. Run ${cli("buy-stake")} again in a minute`,
    );
    expect(await stakeInFlight(MAINNET, failing, {}, NOW)).toBeUndefined();
    expect(await stakeInFlight(MAINNET, failing, { deposit: { ...saved.deposit, at: NOW - 86_400 } }, NOW)).toBeUndefined();
  });

  it("hears a stake deposit's hash as it is sent, and no other asset's", async () => {
    const heard: { tx: Hex; amount: bigint }[] = [];
    const { chain } = fakeChain();
    await bridge(MAINNET, chain, { asset: "stake", amount: "312500", dry: false, log: () => {}, sent: (d) => void heard.push(d) });
    await bridge(MAINNET, chain, { asset: "bounty", amount: "5", dry: false, log: () => {}, sent: (d) => void heard.push(d) });
    expect(heard).toEqual([{ tx: TX, amount: parseEther("312500") }]);
  });
});

describe("stakeDeposits", () => {
  it("reads this wallet's deposits to itself of the stake token from the parent gateway's last day, and their arrivals from the child gateway", async () => {
    const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const self = account.address;
    const STAKE = MAINNET.bridge!.tokens!.stake!;
    const PARENT_GATEWAY: Address = "0x00000000000000000000000000000000000000A7";
    const CHILD_GATEWAY: Address = "0x00000000000000000000000000000000000000A8";
    const pad = (value: string) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
    const initiated = toEventSelector("DepositInitiated(address,address,address,uint256,uint256)");
    const finalized = toEventSelector("DepositFinalized(address,address,address,uint256)");
    const filters: { chain: string; filter: { address: string; topics: (string | null)[]; fromBlock: string } }[] = [];
    const log = (block: number, topics: string[], data: Hex, tx: string) => ({ address: PARENT_GATEWAY, blockNumber: `0x${block.toString(16)}`, blockHash: TX, transactionHash: `0x${tx.repeat(64)}`, transactionIndex: "0x0", logIndex: "0x0", removed: false, topics, data });
    const server = (name: string, answer: (method: string, params: unknown[]) => unknown) =>
      createServer((request, response) => {
        let body = "";
        request.on("data", (c) => (body += c));
        request.on("end", () => {
          const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
          if (method === "eth_getLogs") filters.push({ chain: name, filter: params[0] as (typeof filters)[number]["filter"] });
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: answer(method, params) }));
        });
      });
    const block = (params: unknown[], at: (n: number) => number) => {
      const n = Number(BigInt((params as [string])[0]));
      return { number: `0x${n.toString(16)}`, hash: TX, parentHash: TX, timestamp: `0x${at(n).toString(16)}`, transactions: [], logsBloom: null, nonce: null };
    };
    const parent = server("parent", (method, params) => {
      if (method === "eth_blockNumber") return "0x100000";
      if (method === "eth_getBlockByNumber") return block(params, (n) => 1_000_000 + n);
      if (method === "eth_call") {
        const { data } = params[0] as { data: Hex };
        return pad(data.startsWith(toFunctionSelector("getGateway(address)")) ? PARENT_GATEWAY : CHILD_GATEWAY);
      }
      return [
        log(1_048_000, [initiated, pad(self), pad(self), pad("0x07")], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [STAKE, 5n]), "1"),
        log(1_048_100, [initiated, pad(self), pad(self), pad("0x08")], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [MAINNET.bridge!.tokens!.bounty!, 9n]), "2"),
      ];
    });
    const child = server("child", (method, params) => {
      if (method === "eth_getBlockByNumber") return block(params, () => 2_048_100);
      return [{ ...log(40, [finalized, pad(STAKE), pad(self), pad(self)], encodeAbiParameters([{ type: "uint256" }], [5n]), "3"), address: CHILD_GATEWAY }];
    });
    await Promise.all([parent, child].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
    const url = (s: typeof parent) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const network = { ...MAINNET, rpc: url(child), bridge: { ...MAINNET.bridge!, rpc: url(parent) } };
      expect(await createBridgeChain(network, account).stakeDeposits()).toEqual({
        sent: [{ tx: `0x${"1".repeat(64)}`, amount: 5n, at: 2_048_000 }],
        arrived: [{ tx: `0x${"3".repeat(64)}`, amount: 5n, at: 2_048_100 }],
      });
      const onParent = filters.find((f) => f.chain === "parent")!.filter;
      expect([onParent.address.toLowerCase(), onParent.topics, BigInt(onParent.fromBlock)]).toEqual([PARENT_GATEWAY.toLowerCase(), [initiated, pad(self), pad(self), null], 0x100000n - 750_000n]);
      const onChild = filters.find((f) => f.chain === "child")!.filter;
      expect([onChild.address.toLowerCase(), onChild.topics, BigInt(onChild.fromBlock)]).toEqual([CHILD_GATEWAY.toLowerCase(), [finalized, pad(STAKE), pad(self), pad(self)], 0n]);
    } finally {
      parent.close();
      child.close();
    }
  });
});
