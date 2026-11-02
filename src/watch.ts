import { createPublicClient, createWalletClient, parseAbi, type Address, type Hex, type PrivateKeyAccount } from "viem";

import { brainchainTransport, executorAbi, reason } from "./chain.js";
import { chainOf, type Network } from "./network.js";

/**
 * The constitution's floors, by the function a change calls. A change that
 * crosses one is what the guardian's veto is for. Values in the units the
 * contracts take: basis points, seconds, and USDG in 6 decimals.
 */
export const FLOORS: Record<string, { name: string; check: (args: readonly bigint[]) => string[] }> = {
  "0x85327a44": {
    name: "setParameters",
    check: (w) =>
      [
        w[0]! < 6_000n && "the change bar falls below 60%",
        w[1]! < 86_400n && "the timelock falls below 24 hours",
        w[2]! > 20n && "more than 20 house tasks a day",
        w[3]! > 10_000_000n && "a house bounty above 10 USDG",
        w[4]! > 50_000_000n && "house spend above 50 USDG a day",
      ].filter((r): r is string => typeof r === "string"),
  },
  "0x00dd15f5": {
    name: "setConfig",
    check: (w) =>
      [
        w[0]! < 1_000n && "the hire bar falls below 10%",
        w[1]! < 6_000n && "the grade bar falls below 60%",
        w[2]! < 6_000n && "the ruling bar falls below 60%",
        (w[5]! < 3_600n || w[6]! < 3_600n || w[7]! < 3_600n) && "a grading, dispute or ruling window under an hour",
        w[8]! < 100_000n && "a minimum bounty under 0.1 USDG",
      ].filter((r): r is string => typeof r === "string"),
  },
  "0x30f738be": { name: "setFee", check: (w) => (w[0]! > 500n ? ["a protocol fee above 5%"] : []) },
  "0x731022ff": {
    name: "setModel",
    check: (w) =>
      [w[1]! === 0n && "a house model with no account", w[2]! > 5_000_000n && "a house model priced above 5 USDG"].filter(
        (r): r is string => typeof r === "string",
      ),
  },
  "0x16c38b3c": { name: "setPaused", check: () => [] },
  "0x1f1e4d9f": { name: "setWorkerAllowed", check: () => [] },
  "0xa9059cbb": { name: "transfer", check: () => [] },
};

/** The static words after the selector; a call with dynamic arguments is read as far as its words go. */
export function argumentsOf(data: Hex): readonly bigint[] {
  const body = data.slice(10);
  const words: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) words.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return words;
}

/** What a queued change does to the constitution: nothing, or the floors it crosses. */
export function judge(data: Hex): { name: string; broken: string[] } {
  const selector = data.slice(0, 10).toLowerCase();
  const floor = FLOORS[selector];
  if (!floor) return { name: selector, broken: ["a call the constitution does not list"] };
  return { name: floor.name, broken: floor.check(argumentsOf(data)) };
}

export interface QueuedChange {
  changeId: bigint;
  decisionId: bigint;
  target: Address;
  data: Hex;
  eta: bigint;
  block: bigint;
}

export interface WatchChain {
  account: Address;
  head(): Promise<bigint>;
  queued(fromBlock: bigint, toBlock: bigint): Promise<QueuedChange[]>;
  /** Whether a change still waits to run. */
  open(changeId: bigint): Promise<boolean>;
  /** How many decisions the log holds. */
  decisions(): Promise<bigint>;
  /** Vetoes through the guardian gate; absent where the network has no gate or the worker holds no watcher key. */
  veto?(changeId: bigint, reason: string): Promise<Hex>;
}

const gateAbi = parseAbi(["function veto(uint256 changeId, string reason)", "function watcher() view returns (address)"]);
const logAbi = parseAbi(["function count() view returns (uint256)"]);

export function createWatchChain(network: Network, account: PrivateKeyAccount): WatchChain {
  const transport = brainchainTransport(network);
  const client = createPublicClient({ chain: chainOf(network), transport, pollingInterval: 1_000 });
  const wallet = createWalletClient({ account, chain: chainOf(network), transport });
  const executor = network.contracts.executor;
  const gate = network.contracts.gate;
  return {
    account: account.address,
    head: () => client.getBlockNumber(),
    async queued(fromBlock, toBlock) {
      const logs = await client.getContractEvents({ address: executor, abi: executorAbi, eventName: "Queued", fromBlock, toBlock });
      return logs.map((log) => ({
        changeId: log.args.changeId!,
        decisionId: log.args.decisionId!,
        target: log.args.target!,
        data: log.args.data!,
        eta: log.args.eta!,
        block: log.blockNumber,
      }));
    },
    async open(changeId) {
      const change = await client.readContract({ address: executor, abi: executorAbi, functionName: "getChange", args: [changeId] });
      return !change.executed && !change.vetoed;
    },
    decisions: () => client.readContract({ address: network.contracts.log, abi: logAbi, functionName: "count" }),
    ...(gate
      ? {
          async veto(changeId: bigint, why: string) {
            const watcher = await client.readContract({ address: gate, abi: gateAbi, functionName: "watcher" });
            if (watcher.toLowerCase() !== account.address.toLowerCase()) throw new Error(`the gate's watcher is ${watcher}, not this worker`);
            const hash = await wallet.writeContract({ address: gate, abi: gateAbi, functionName: "veto", args: [changeId, why] });
            await client.waitForTransactionReceipt({ hash });
            return hash;
          },
        }
      : {}),
  };
}

/** Re-checks one decision against the chain and the published record; the findings are what disagreed. */
export type Verify = (id: bigint) => Promise<{ findings: string[] }>;

/**
 * Watches the chain for the worker: every queued change is judged against the
 * constitution and, with `veto` on, one that crosses a floor is vetoed through
 * the guardian gate; every new decision is re-verified. Each round reports
 * what it found and keeps where it got to.
 */
export function createWatch(options: {
  network: Network;
  chain: WatchChain;
  verify?: Verify;
  veto: boolean;
  log: (line: string) => void;
  /** Where the first round starts reading; later rounds continue from the last block seen. */
  fromBlock?: bigint;
}) {
  const { network, chain, verify, log } = options;
  let nextBlock = options.fromBlock ?? network.fromBlock;
  let seenDecision: bigint | undefined;
  const judged = new Set<string>();
  let findings = 0;

  async function changes(): Promise<void> {
    const head = await chain.head();
    if (head < nextBlock) return;
    const span = 5_000n;
    for (let from = nextBlock; from <= head; from += span) {
      const to = from + span - 1n < head ? from + span - 1n : head;
      for (const change of await chain.queued(from, to)) {
        const key = change.changeId.toString();
        if (judged.has(key)) continue;
        judged.add(key);
        const { name, broken } = judge(change.data);
        const runsAt = new Date(Number(change.eta) * 1000).toISOString().replace("T", " ").slice(0, 16);
        if (broken.length === 0) {
          log(`change ${change.changeId}: ${name} on ${change.target}, within the constitution, runs after ${runsAt} UTC`);
          continue;
        }
        findings += 1;
        const why = broken.join("; ");
        log(`change ${change.changeId}: ${name} on ${change.target} breaks the constitution (${why}), runs after ${runsAt} UTC`);
        if (!options.veto) continue;
        if (!(await chain.open(change.changeId))) {
          log(`change ${change.changeId} is closed already, nothing to veto`);
          continue;
        }
        if (!chain.veto) {
          log(`cannot veto: ${network.name} has no guardian gate this worker can reach`);
          continue;
        }
        try {
          const hash = await chain.veto(change.changeId, `Breaks the constitution: ${why}`);
          log(`vetoed change ${change.changeId} through the guardian gate: ${hash}`);
        } catch (error) {
          log(`veto of change ${change.changeId} failed: ${reason(error)}`);
        }
      }
    }
    nextBlock = head + 1n;
  }

  async function decisions(): Promise<void> {
    if (!verify) return;
    const count = await chain.decisions();
    // The first round only notes where the log stands; later ones check what was added.
    if (seenDecision === undefined) {
      seenDecision = count;
      log(`${count} decisions recorded so far; new ones are checked from here`);
      return;
    }
    for (let id = seenDecision + 1n; id <= count; id++) {
      try {
        const { findings: wrong } = await verify(id);
        if (wrong.length === 0) log(`decision ${id} verified`);
        else {
          findings += 1;
          log(`decision ${id} does not verify: ${wrong.join("; ")}`);
        }
      } catch (error) {
        log(`decision ${id} could not be checked: ${reason(error)}`);
      }
    }
    seenDecision = count;
  }

  return {
    async round(): Promise<{ findings: number }> {
      await changes();
      await decisions();
      return { findings };
    },
  };
}
