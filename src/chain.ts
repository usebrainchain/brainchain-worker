import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

import { taskBoardAbi, workerStakingAbi } from "./abi.js";
import { chainOf, type Network } from "./network.js";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function faucet()",
  "error TooSoon(uint256 nextClaimAt)",
]);

export const bondsAbi = parseAbi([
  "event Proposed(uint256 indexed id, address indexed proposer, address indexed target, bytes data, uint128 bond, string uri)",
  "function propose(address target, bytes data, string uri) returns (uint256)",
  "function get(uint256 id) view returns ((address proposer, uint128 bond, uint64 createdAt, uint8 state, bytes32 subject))",
  "function bond() view returns (uint128)",
]);

export const executorAbi = parseAbi([
  "event Queued(uint256 indexed changeId, uint256 indexed decisionId, address indexed target, bytes data, uint64 eta)",
  "function getChange(uint256 changeId) view returns ((address target, bytes data, uint64 eta, bool executed, bool vetoed))",
]);

/** Mirrors TaskBoard.Status. */
export const Status = { Open: 1, Hired: 2, Submitted: 3, Graded: 4, Disputed: 5, Paid: 6, Refunded: 7 } as const;
/** Mirrors ProposalBonds.State. */
export const ApplicationState = { Open: 1, Returned: 2, Burned: 3 } as const;

const LOG_RANGE = 50_000n;

export interface HiredTask {
  id: bigint;
  deadline: bigint;
  briefURI: string;
  briefHash: Hex;
}

/** What the work loop needs from the chain and the service. */
export interface WorkerChain {
  now(): Promise<bigint>;
  hired(): Promise<HiredTask[]>;
  /** Uploads a result to the service, which serves it once Jev accepts the work. */
  publish(id: bigint, text: string): Promise<{ uri: string; hash: Hex }>;
  submit(id: bigint, resultHash: Hex, resultURI: string): Promise<Hex>;
}

/** What the worker signs to upload a result: the task and the hash of exactly the bytes it uploads. */
export function resultMessage(task: bigint, hash: Hex): string {
  return `BrainChain result\ntask ${task}\nhash ${hash}`;
}

/** WorkerStaking.idOf: a worker's id is its account, left-padded to 32 bytes. */
export function workerId(account: Address): Hex {
  return `0x${account.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function applicationData(account: Address): Hex {
  return encodeFunctionData({ abi: taskBoardAbi, functionName: "setWorkerAllowed", args: [account, true] });
}

export function createChain(network: Network, account: PrivateKeyAccount) {
  const chain = chainOf(network);
  const transport = http(network.rpc, { timeout: 20_000, retryCount: 3 });
  // BrainChain mines a block per transaction, so receipts are polled every second.
  const client = createPublicClient({ chain, transport, pollingInterval: 1_000 });
  const wallet = createWalletClient({ account, chain, transport });
  const { taskBoard, staking, bonds, executor, stakeToken, bountyToken } = network.contracts;
  const id = workerId(account.address);
  const board = { address: taskBoard, abi: taskBoardAbi } as const;

  async function send(request: Parameters<typeof wallet.writeContract>[0]): Promise<Hex> {
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
    return hash;
  }

  /** Every log of one event up to `latest`, in windows the RPC accepts. */
  async function scan<T>(fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>, upTo?: bigint): Promise<T[]> {
    const latest = upTo ?? (await client.getBlockNumber());
    const all: T[] = [];
    for (let from = network.fromBlock; from <= latest; from += LOG_RANGE) {
      const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
      all.push(...(await fetch(from, to)));
    }
    return all;
  }

  const hiredIds = () =>
    scan((fromBlock, toBlock) => client.getContractEvents({ ...board, eventName: "WorkerHired", args: { model: id }, fromBlock, toBlock })).then((logs) =>
      logs.map((log) => log.args.id!),
    );

  const briefs = new Map<bigint, string>();
  async function briefURI(task: bigint): Promise<string> {
    const known = briefs.get(task);
    if (known !== undefined) return known;
    const [posted] = await scan((fromBlock, toBlock) => client.getContractEvents({ ...board, eventName: "Posted", args: { id: task }, fromBlock, toBlock }));
    if (posted === undefined) throw new Error(`Task ${task} has no Posted event`);
    briefs.set(task, posted.args.briefURI!);
    return posted.args.briefURI!;
  }

  const settled = new Set<bigint>();

  const work: WorkerChain = {
    async now() {
      const block = await client.getBlock();
      const wall = BigInt(Math.floor(Date.now() / 1000));
      // An idle chain makes no blocks, so the latest block's time can lag the clock.
      return block.timestamp > wall ? block.timestamp : wall;
    },
    async hired() {
      const ids = (await hiredIds()).filter((t) => !settled.has(t));
      const tasks: HiredTask[] = [];
      for (const task of ids) {
        const t = await client.readContract({ ...board, functionName: "get", args: [task] });
        if (t.status !== Status.Hired || t.model.toLowerCase() !== id) {
          if (t.status >= Status.Paid) settled.add(task);
          continue;
        }
        tasks.push({ id: task, deadline: t.deadline, briefURI: await briefURI(task), briefHash: t.briefHash });
      }
      return tasks;
    },
    async publish(task, text) {
      const hash = keccak256(toBytes(text));
      const signature = await account.signMessage({ message: resultMessage(task, hash) });
      const response = await fetch(`${network.service}/results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: task.toString(), text, signature }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => ({}))) as { uri?: string; hash?: Hex; error?: string };
      if (!response.ok || !body.uri) throw new Error(`Uploading the result failed (${response.status}): ${body.error ?? "no reason given"}`);
      if (body.hash?.toLowerCase() !== hash.toLowerCase()) throw new Error("The service stored different bytes than were sent");
      return { uri: body.uri, hash };
    },
    submit: (task, resultHash, resultURI) => send({ ...board, functionName: "submit", args: [task, resultHash, resultURI] }),
  };

  return {
    ...work,
    account: account.address,
    id,
    client,
    send,
    ethBalance: () => client.getBalance({ address: account.address }),
    balance: (token: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    stakeBalance: () => client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    bountyBalance: () => client.readContract({ address: bountyToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    stake: () => client.readContract({ address: staking, abi: workerStakingAbi, functionName: "get", args: [account.address] }),
    minStake: () => client.readContract({ address: staking, abi: workerStakingAbi, functionName: "minStake" }),
    inFlight: () => client.readContract({ address: staking, abi: workerStakingAbi, functionName: "held", args: [account.address] }),
    allowed: () => client.readContract({ ...board, functionName: "workerAllowed", args: [account.address] }),
    bond: () => client.readContract({ address: bonds, abi: bondsAbi, functionName: "bond" }),
    async approve(token: Address, spender: Address, amount: bigint) {
      const current = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
      if (current >= amount) return;
      await send({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    },
    claimStakeToken: () => send({ address: stakeToken, abi: erc20Abi, functionName: "faucet" }),
    stakeTokens: (amount: bigint, price: bigint) => send({ address: staking, abi: workerStakingAbi, functionName: "stake", args: [amount, price] }),
    setPrice: (price: bigint) => send({ address: staking, abi: workerStakingAbi, functionName: "setPrice", args: [price] }),
    requestUnstake: (amount: bigint) => send({ address: staking, abi: workerStakingAbi, functionName: "requestUnstake", args: [amount] }),
    withdraw: () => send({ address: staking, abi: workerStakingAbi, functionName: "withdraw" }),
    apply: (profileURI: string) =>
      send({ address: bonds, abi: bondsAbi, functionName: "propose", args: [taskBoard, applicationData(account.address), profileURI] }),
    /**
     * This worker's applications, newest last, with their state, and the last
     * change any of them queued. Everything is read at one block, so a bond
     * settled just after its change was queued is never seen without the change.
     */
    async applications() {
      const data = applicationData(account.address).toLowerCase();
      const blockNumber = await client.getBlockNumber();
      const [proposed, queued] = await Promise.all([
        scan((fromBlock, toBlock) => client.getContractEvents({ address: bonds, abi: bondsAbi, eventName: "Proposed", args: { proposer: account.address, target: taskBoard }, fromBlock, toBlock }), blockNumber),
        scan((fromBlock, toBlock) => client.getContractEvents({ address: executor, abi: executorAbi, eventName: "Queued", args: { target: taskBoard }, fromBlock, toBlock }), blockNumber),
      ]);
      const mine = queued.filter((log) => log.args.data!.toLowerCase() === data).at(-1);
      const change = mine ? await client.readContract({ address: executor, abi: executorAbi, functionName: "getChange", args: [mine.args.changeId!], blockNumber }) : undefined;
      const applications = await Promise.all(
        proposed
          .filter((log) => log.args.data!.toLowerCase() === data)
          .map(async (log) => ({ id: log.args.id!, state: (await client.readContract({ address: bonds, abi: bondsAbi, functionName: "get", args: [log.args.id!], blockNumber })).state })),
      );
      return { applications, change };
    },
    /** Tasks this worker was hired for, by outcome, and what it was paid after fees. */
    async record() {
      const ids = [...new Set(await hiredIds())];
      const tasks = await Promise.all(ids.map((task) => client.readContract({ ...board, functionName: "get", args: [task] })));
      const paid = await scan((fromBlock, toBlock) => client.getContractEvents({ ...board, eventName: "BountyPaid", args: { account: account.address }, fromBlock, toBlock }));
      const count = (statuses: number[]) => tasks.filter((t) => statuses.includes(t.status)).length;
      return {
        accepted: count([Status.Paid]),
        refunded: tasks.filter((t) => t.status === Status.Refunded && t.model.toLowerCase() === id).length,
        inFlight: count([Status.Hired, Status.Submitted, Status.Graded, Status.Disputed]),
        earned: paid.reduce((sum, log) => sum + log.args.bounty! - log.args.fee!, 0n),
      };
    },
  };
}

export type Chain = ReturnType<typeof createChain>;

/** Reads a brief and checks it against the hash on chain. Briefs are base64 data URIs or https URLs. */
export async function fetchBrief(uri: string, expected: Hex, fetcher: typeof fetch = fetch): Promise<string> {
  const MAX = 256 * 1024;
  let bytes: Uint8Array;
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0 || !uri.slice(0, comma).endsWith(";base64")) throw new Error("The brief's data URI is not base64");
    bytes = Uint8Array.from(Buffer.from(uri.slice(comma + 1), "base64"));
  } else if (uri.startsWith("https://")) {
    const response = await fetcher(uri, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`The brief answered ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    throw new Error("The brief is neither a data URI nor an https URL");
  }
  if (bytes.byteLength > MAX) throw new Error("The brief is too large");
  if (keccak256(bytes).toLowerCase() !== expected.toLowerCase()) throw new Error("The brief does not match its hash on chain");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
