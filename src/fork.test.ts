// buy-stake end to end on an anvil fork of Robinhood Chain: a live price and quote bought through 0x's keyless gateway,
// checked, simulated and swapped for a fresh key, then bridged, and a second run refused while that deposit is in
// flight. Every transaction goes to the fork; BrainChain is only read. It runs with ROBINHOOD_RPC (the chain to fork)
// and ZEROX_PAYER_KEY_FILE (a key with USDC on Base, which pays 0.01 USDC per request, four in all), and ANVIL naming
// an anvil that can fork Robinhood Chain (1.5.0 can; 1.8 cannot). It is skipped without them.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { createPublicClient, erc20Abi, formatEther, formatUnits, http, pad, parseEther, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { bridge, createBridgeChain, stakeInFlight, stakeProblem, type StakeMoves } from "./bridge.js";
import { buyStake, createBuyChain, type Pay } from "./buy.js";
import { createChain } from "./chain.js";
import { MAINNET } from "./network.js";
import { relayPrice } from "./relay.js";
import { snapshot } from "./standing.js";
import { createQuoter } from "./zerox.js";

const RPC = process.env.ROBINHOOD_RPC;
const PAYER = process.env.ZEROX_PAYER_KEY_FILE;
const PORT = 8547;
const FORK = `http://127.0.0.1:${PORT}`;
const network = { ...MAINNET, bridge: { ...MAINNET.bridge!, rpc: FORK } };
const brain = network.bridge.tokens!.stake!;
const usdg = network.bridge.tokens!.bounty!;
const fork = createPublicClient({ transport: http(FORK) });
const rpc = (method: string, params: unknown[]) => fork.request({ method, params } as never) as Promise<unknown>;

describe.skipIf(!RPC || !PAYER)("buy-stake on a fork of Robinhood Chain", () => {
  const payer = PAYER ? privateKeyToAccount(readFileSync(PAYER, "utf8").trim().replace(/^(0x)?/, "0x") as Hex) : undefined;
  const base = createPublicClient({ transport: http(MAINNET.zerox!.payment.rpc) });

  /** A fresh fork for each run, since a buy moves the pool the next run's quote was priced on. */
  async function onFork(run: () => Promise<void>) {
    const anvil = spawn(process.env.ANVIL ?? "anvil", ["--fork-url", RPC!, "--port", String(PORT), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
    try {
      for (let tries = 0; ; tries++) {
        try {
          await fork.getBlockNumber();
          break;
        } catch (error) {
          if (tries > 60) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      // Oracle pools on the route take a price update every block on mainnet and refuse a stale one; the fork gets
      // none, so its clock moves a second a block instead of with the wall clock.
      await rpc("anvil_setBlockTimestampInterval", [1]);
      // anvil has none of Arbitrum's precompiles, and a hooked pool on the USDG route asks ArbSys for the block
      // number. This stub answers every call with it, as ArbSys's arbBlockNumber does on Robinhood Chain.
      await rpc("anvil_setCode", ["0x0000000000000000000000000000000000000064", "0x435f5260205ff3"]);
      await run();
    } finally {
      anvil.kill("SIGTERM");
    }
  }

  async function fund(address: Address, pay: Pay) {
    await rpc("anvil_setBalance", [address, toHex(parseEther("1"))]);
    if (pay === "eth") return;
    // USDG is a proxy with its own layout, so the slot balanceOf reads is found by tracing it.
    const trace = (await rpc("debug_traceCall", [{ to: usdg, data: `0x70a08231${pad(address).slice(2)}` }, "latest", { tracer: "prestateTracer" }])) as Record<string, { storage?: Record<string, Hex> }>;
    const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const slot = Object.keys(trace[usdg.toLowerCase()]!.storage!).find((s) => s !== implementationSlot)!;
    await rpc("anvil_setStorageAt", [usdg, slot, pad(toHex(500_000_000n))]);
  }

  async function buy(account: ReturnType<typeof privateKeyToAccount>, pay: Pay, saved: StakeMoves, quotes: { count: number }) {
    const lines: string[] = [];
    const log = (line: string) => {
      lines.push(line);
      console.log(line);
    };
    const bridgeChain = {
      ...createBridgeChain(network, account),
      // The fork proves the swap and the deposit; whether the live service already names this release's set is
      // the unit tests' to check.
      activeSet: async () => ({
        contracts: {
          TaskBoard: network.contracts.taskBoard,
          WorkerStaking: network.contracts.staking,
          ProposalBonds: network.contracts.bonds,
          DecisionExecutor: network.contracts.executor,
          ModelRegistry: network.contracts.registry,
          DecisionLog: network.contracts.log,
        },
      }),
    };
    const brainchain = createChain(network, account);
    const quote = createQuoter(network.zerox!, payer!);
    await buyStake(
      network,
      {
        // The fresh key holds nothing on Base, so the payer's USDC pays for the quote.
        chain: { ...createBuyChain(network, account), paymentBalance: () => base.readContract({ address: MAINNET.zerox!.payment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer!.address] }) },
        async needs() {
          const [s, bond, held] = await Promise.all([snapshot(brainchain), brainchain.bond(), brainchain.stakeBalance()]);
          return { need: s.toStake + (s.applying ? bond : 0n), held };
        },
        stakeProblem: () => stakeProblem(network, bridgeChain, log),
        inFlight: () => stakeInFlight(network, bridgeChain, saved),
        price: (token) => relayPrice(network.bridge.chainId, token),
        quote: (query, kind) => {
          quotes.count += 1;
          return quote(query, kind);
        },
        swapSent: (tx) => void (saved.swap = { tx, at: Math.floor(Date.now() / 1000) }),
        bridge: (amount) =>
          bridge(network, bridgeChain, { asset: "stake", amount: formatUnits(amount, 18), dry: false, log, sent: ({ tx }) => void (saved.deposit = { tx, amount, at: Math.floor(Date.now() / 1000) }) }),
      },
      { pay, dry: false, yes: true, log },
    );
    return lines;
  }

  for (const pay of ["eth", "usdg"] as const) {
    it(`buys the stake with ${pay === "eth" ? "ETH" : "USDG"} from a fresh key, bridges it, and refuses a second buy while the deposit is in flight`, () =>
      onFork(async () => {
        const account = privateKeyToAccount(generatePrivateKey());
        expect(await fork.getCode({ address: account.address })).toBeUndefined();
        await fund(account.address, pay);
        const [eth, usdgHeld] = await Promise.all([fork.getBalance({ address: account.address }), fork.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })]);
        console.log(`fork of Robinhood Chain at block ${await fork.getBlockNumber()}; ${account.address} holds ${formatEther(eth)} ETH and ${formatUnits(usdgHeld, 6)} USDG there`);
        const saved: StakeMoves = {};
        const quotes = { count: 0 };
        const lines = await buy(account, pay, saved, quotes);
        expect(quotes.count).toBe(2);
        const bought = /^Bought ([\d,]+) BRAIN on Robinhood Chain: 0x[0-9a-f]{64}\. The ([\d,]+) BRAIN beyond what join needs stay in the wallet there\.$/.exec(lines.find((line) => line.startsWith("Bought ")) ?? "");
        expect(bought).not.toBeNull();
        expect(lines.some((line) => line.startsWith("sent, arrives on BrainChain in about a minute: 0x"))).toBe(true);
        expect(saved.swap?.tx).toMatch(/^0x[0-9a-f]{64}$/);
        expect(saved.deposit?.amount).toBe(312_500n * 10n ** 18n);
        // What join needs is bridged, and the rest stays on the fork.
        const left = await fork.readContract({ address: brain, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
        expect(left).toBeGreaterThan(0n);
        console.log(`left in the wallet on the fork: ${formatUnits(left, 18)} BRAIN`);

        // The deposit went to the fork, so BrainChain never sees it arrive: a second run must stop before it pays.
        await expect(buy(account, pay, saved, quotes)).rejects.toThrow(/^A deposit of 312,500 BRAIN from this wallet, sent .* has not arrived on BrainChain yet, and buying now would buy it again\. .*Nothing was paid\.$/s);
        expect(quotes.count).toBe(2);
      }),
      240_000,
    );
  }
});
