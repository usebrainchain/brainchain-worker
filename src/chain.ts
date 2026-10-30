import { isIP } from "node:net";

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  HttpRequestError,
  keccak256,
  parseAbi,
  TimeoutError,
  toBytes,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

import { erc20Errors, taskBoardAbi, workerStakingAbi } from "./abi.js";
import { chainOf, type Network } from "./network.js";
import { memoryStore, type Store } from "./state.js";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function faucet()",
  "function FAUCET_AMOUNT() view returns (uint256)",
  "function FAUCET_INTERVAL() view returns (uint256)",
  "function lastClaim(address) view returns (uint256)",
  "error TooSoon(uint256 nextClaimAt)",
]);

export const bondsAbi = [
  ...parseAbi([
    "event Proposed(uint256 indexed id, address indexed proposer, address indexed target, bytes data, uint128 bond, string uri)",
    "event Settled(uint256 indexed id, uint256 indexed decisionId, bool adopted)",
    "function propose(address target, bytes data, string uri) returns (uint256)",
    "function get(uint256 id) view returns ((address proposer, uint128 bond, uint64 createdAt, uint8 state, bytes32 subject))",
    "function bond() view returns (uint128)",
  ]),
  ...erc20Errors,
] as const;

export const executorAbi = parseAbi([
  "event Queued(uint256 indexed changeId, uint256 indexed decisionId, address indexed target, bytes data, uint64 eta)",
  "function getChange(uint256 changeId) view returns ((address target, bytes data, uint64 eta, bool executed, bool vetoed))",
]);

/** Mirrors TaskBoard.Status. */
export const Status = { Open: 1, Hired: 2, Submitted: 3, Graded: 4, Disputed: 5, Paid: 6, Refunded: 7 } as const;
/** Mirrors ProposalBonds.State. */
export const ApplicationState = { Open: 1, Returned: 2, Burned: 3 } as const;

const LOG_RANGE = 50_000n;
const MAX_BRIEF_BYTES = 256 * 1024;
/** What the service answers when it will never take this result. */
const REFUSED = [400, 403, 409, 413];

export interface HiredTask {
  id: bigint;
  deadline: bigint;
  briefURI: string;
  briefHash: Hex;
}

/** A failure that trying again cannot fix. */
export class PermanentError extends Error {}

/** What the work loop needs from the chain and the service. */
export interface WorkerChain {
  now(): Promise<bigint>;
  /** Tasks hired to this worker that wait for its result. */
  hired(): Promise<HiredTask[]>;
  ethBalance(): Promise<bigint>;
  /** Uploads a result to the service, which serves it once Jev accepts the work. */
  publish(id: bigint, text: string): Promise<{ uri: string; hash: Hex }>;
  submit(id: bigint, resultHash: Hex, resultURI: string): Promise<Hex>;
}

/** What the worker signs to upload a result: the chain, the board, the task and the hash of exactly the bytes it uploads. */
export function resultMessage(chainId: number, board: Address, task: bigint, hash: Hex): string {
  return ["BrainChain result v2", `chain ${chainId}`, `board ${board.toLowerCase()}`, `task ${task}`, `hash ${hash}`].join("\n");
}

/** WorkerStaking.idOf: a worker's id is its account, left-padded to 32 bytes. */
export function workerId(account: Address): Hex {
  return `0x${account.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function applicationData(account: Address): Hex {
  return encodeFunctionData({ abi: taskBoardAbi, functionName: "setWorkerAllowed", args: [account, true] });
}

/** The contract error a call reverted with, when the ABI knows it. */
function revertOf(error: unknown) {
  const revert = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  return revert instanceof ContractFunctionRevertedError ? revert.data : undefined;
}

export function submitFailure(error: unknown): unknown {
  const name = revertOf(error)?.errorName;
  if (name === "TooLate") return new PermanentError("The deadline passed before the result could be submitted");
  if (name === "BadStatus") return new PermanentError("The task no longer waits for a result");
  return error;
}

/** When the faucet opens again for this wallet, if it refused a claim as too soon. */
export function faucetReopens(error: unknown): bigint | undefined {
  const revert = revertOf(error);
  return revert?.errorName === "TooSoon" ? (revert.args?.[0] as bigint) : undefined;
}

const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : "the RPC");

/** viem passes on an answer that is not JSON as a quoted JSON string. */
function unquote(text: string): string {
  if (!text.startsWith('"')) return text;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : text;
  } catch {
    return text;
  }
}

/** A URL that is not an RPC, such as a web page, answers with a whole page; one short line of it is enough. */
function excerpt(details: string): string {
  const line = unquote(details)
    .replace(/\s+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** One readable line for an error. It names the RPC by host only: its URL can hold an API key. */
export function reason(error: unknown): string {
  if (!(error instanceof BaseError)) return error instanceof Error ? error.message : String(error);
  const request = error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError);
  if (request instanceof HttpRequestError || request instanceof TimeoutError) {
    const host = hostOf(request.url);
    const details = request.details ? excerpt(request.details) : "";
    if (details.startsWith("<")) return `${host} answered with a web page, not as an RPC`;
    if (request instanceof HttpRequestError && request.status) return `${host} answered ${request.status}${details ? ` (${details})` : ""}`;
    return `Could not reach ${host}${details ? ` (${details})` : ""}`;
  }
  const name = revertOf(error)?.errorName;
  return name ? `${error.shortMessage} (${name})` : error.shortMessage;
}

/** Why the BrainChain service failed its health check, or undefined when it passed. */
export async function unhealthy(service: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const host = new URL(service).host;
  const response = await fetcher(`${service}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (response === undefined) return `could not reach the BrainChain service at ${host}`;
  await response.body?.cancel();
  return response.ok ? undefined : `the BrainChain service at ${host} answered its health check with ${response.status}`;
}

export function createChain(network: Network, account: PrivateKeyAccount, store: Store = memoryStore()) {
  const chain = chainOf(network);
  const transport = http(network.rpc, { timeout: 20_000, retryCount: 3 });
  // BrainChain mines a block per transaction, so receipts are polled every second.
  const client = createPublicClient({ chain, transport, pollingInterval: 1_000 });
  const wallet = createWalletClient({ account, chain, transport });
  const { taskBoard, staking, bonds, executor, stakeToken, bountyToken } = network.contracts;
  const id = workerId(account.address);
  const board = { address: taskBoard, abi: taskBoardAbi } as const;
  const origin = new URL(network.service).origin;

  async function send(request: Parameters<typeof wallet.writeContract>[0]): Promise<Hex> {
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
    return hash;
  }

  /** Every log of one event from `from` to `to`, in windows the RPC accepts. */
  async function scan<T>(fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
    const all: T[] = [];
    for (let start = from; start <= to; start += LOG_RANGE) {
      const end = start + LOG_RANGE - 1n < to ? start + LOG_RANGE - 1n : to;
      all.push(...(await fetch(start, end)));
    }
    return all;
  }

  const hiredLogs = (from: bigint, to: bigint) =>
    scan((fromBlock, toBlock) => client.getContractEvents({ ...board, eventName: "WorkerHired", args: { model: id }, fromBlock, toBlock }), from, to);

  const briefs = new Map<bigint, string>();
  async function briefURI(task: bigint, latest: bigint): Promise<string> {
    const known = briefs.get(task);
    if (known !== undefined) return known;
    const [posted] = await scan(
      (fromBlock, toBlock) => client.getContractEvents({ ...board, eventName: "Posted", args: { id: task }, fromBlock, toBlock }),
      network.fromBlock,
      latest,
    );
    if (posted === undefined) throw new Error(`Task ${task} has no Posted event`);
    briefs.set(task, posted.args.briefURI!);
    return posted.args.briefURI!;
  }

  const work: WorkerChain = {
    async now() {
      const block = await client.getBlock();
      const wall = BigInt(Math.floor(Date.now() / 1000));
      // An idle chain makes no blocks, so the latest block's time can lag the clock.
      return block.timestamp > wall ? block.timestamp : wall;
    },
    async hired() {
      const latest = await client.getBlockNumber();
      const known = store.state.hired;
      const ids = new Set(known?.tasks);
      for (const log of await hiredLogs(known ? BigInt(known.block) + 1n : network.fromBlock, latest)) ids.add(log.args.id!.toString());
      const tasks = await Promise.all(
        [...ids].map(async (key) => {
          const task = BigInt(key);
          const t = await client.readContract({ ...board, functionName: "get", args: [task] });
          if (t.status === Status.Hired && t.model.toLowerCase() === id) {
            return { id: task, deadline: t.deadline, briefURI: await briefURI(task, latest), briefHash: t.briefHash };
          }
          // A task never returns to Hired, the only state that waits on the worker.
          briefs.delete(task);
          return undefined;
        }),
      );
      const hired = tasks.filter((t) => t !== undefined);
      store.state.hired = { block: Number(latest), tasks: hired.map((t) => t.id.toString()) };
      store.save();
      return hired;
    },
    ethBalance: () => client.getBalance({ address: account.address }),
    async publish(task, text) {
      const hash = keccak256(toBytes(text));
      const signature = await account.signMessage({ message: resultMessage(network.chainId, taskBoard, task, hash) });
      const response = await fetch(`${network.service}/results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: task.toString(), text, signature }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => {
        throw new Error(`Could not reach the BrainChain service at ${new URL(origin).host}`);
      });
      const body = (await response.json().catch(() => ({}))) as { uri?: string; hash?: Hex; error?: string };
      const why = `(${response.status}): ${body.error ?? "no reason given"}`;
      if (REFUSED.includes(response.status)) throw new PermanentError(`The service refused the result ${why}`);
      if (!response.ok || !body.uri) throw new Error(`Uploading the result failed ${why}`);
      if (body.hash?.toLowerCase() !== hash) throw new Error("The service stored different bytes than were sent");
      if (!body.uri.startsWith(`${origin}/`)) throw new Error(`The service returned a result address outside ${origin}`);
      return { uri: body.uri, hash };
    },
    submit: (task, resultHash, resultURI) =>
      send({ ...board, functionName: "submit", args: [task, resultHash, resultURI] }).catch((error: unknown) => {
        throw submitFailure(error);
      }),
  };

  return {
    ...work,
    account: account.address,
    stakeBalance: () => client.readContract({ address: stakeToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    bountyBalance: () => client.readContract({ address: bountyToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    stake: () => client.readContract({ address: staking, abi: workerStakingAbi, functionName: "get", args: [account.address] }),
    minStake: () => client.readContract({ address: staking, abi: workerStakingAbi, functionName: "minStake" }),
    held: () => client.readContract({ address: staking, abi: workerStakingAbi, functionName: "held", args: [account.address] }),
    allowed: () => client.readContract({ ...board, functionName: "workerAllowed", args: [account.address] }),
    bond: () => client.readContract({ address: bonds, abi: bondsAbi, functionName: "bond" }),
    async approve(token: Address, spender: Address, amount: bigint) {
      const current = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
      if (current >= amount) return;
      await send({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    },
    claimStakeToken: () => send({ address: stakeToken, abi: erc20Abi, functionName: "faucet" }),
    /** What the stake token's faucet gives, and from when this wallet can claim it. */
    async faucet() {
      const token = { address: stakeToken, abi: erc20Abi } as const;
      const [amount, interval, last] = await Promise.all([
        client.readContract({ ...token, functionName: "FAUCET_AMOUNT" }),
        client.readContract({ ...token, functionName: "FAUCET_INTERVAL" }),
        client.readContract({ ...token, functionName: "lastClaim", args: [account.address] }),
      ]);
      return { amount, opensAt: last === 0n ? 0n : last + interval };
    },
    stakeTokens: (amount: bigint, price: bigint) => send({ address: staking, abi: workerStakingAbi, functionName: "stake", args: [amount, price] }),
    setPrice: (price: bigint) => send({ address: staking, abi: workerStakingAbi, functionName: "setPrice", args: [price] }),
    requestUnstake: (amount: bigint) => send({ address: staking, abi: workerStakingAbi, functionName: "requestUnstake", args: [amount] }),
    withdraw: () => send({ address: staking, abi: workerStakingAbi, functionName: "withdraw" }),
    apply: (profileURI: string) =>
      send({ address: bonds, abi: bondsAbi, functionName: "propose", args: [taskBoard, applicationData(account.address), profileURI] }),
    /**
     * This worker's applications, newest last, with their state and the
     * decision that settled each, and the last change any of them queued.
     * Everything is read at one block, so a bond settled just after its change
     * was queued is never seen without the change.
     */
    async applications() {
      const data = applicationData(account.address).toLowerCase();
      const blockNumber = await client.getBlockNumber();
      const proposed = (
        await scan(
          (fromBlock, toBlock) =>
            client.getContractEvents({ address: bonds, abi: bondsAbi, eventName: "Proposed", args: { proposer: account.address, target: taskBoard }, fromBlock, toBlock }),
          network.fromBlock,
          blockNumber,
        )
      ).filter((log) => log.args.data!.toLowerCase() === data);
      // Queued does not index the call, so its scan narrows to the board as target and to blocks from this worker's first application on.
      const since = proposed[0]?.blockNumber ?? blockNumber + 1n;
      const [settled, queued] = await Promise.all([
        scan(
          (fromBlock, toBlock) =>
            client.getContractEvents({ address: bonds, abi: bondsAbi, eventName: "Settled", args: { id: proposed.map((log) => log.args.id!) }, fromBlock, toBlock }),
          since,
          blockNumber,
        ),
        scan(
          (fromBlock, toBlock) => client.getContractEvents({ address: executor, abi: executorAbi, eventName: "Queued", args: { target: taskBoard }, fromBlock, toBlock }),
          since,
          blockNumber,
        ),
      ]);
      const mine = queued.filter((log) => log.args.data!.toLowerCase() === data).at(-1);
      const change = mine && {
        ...(await client.readContract({ address: executor, abi: executorAbi, functionName: "getChange", args: [mine.args.changeId!], blockNumber })),
        decisionId: mine.args.decisionId!,
      };
      const decided = new Map(settled.map((log) => [log.args.id!, log.args.decisionId!]));
      const applications = await Promise.all(
        proposed.map(async (log) => ({
          id: log.args.id!,
          state: (await client.readContract({ address: bonds, abi: bondsAbi, functionName: "get", args: [log.args.id!], blockNumber })).state,
          decisionId: decided.get(log.args.id!),
        })),
      );
      return { applications, change };
    },
    /** Tasks this worker was hired for, by outcome, and what it was paid after fees. */
    async record() {
      const latest = await client.getBlockNumber();
      const ids = [...new Set((await hiredLogs(network.fromBlock, latest)).map((log) => log.args.id!))];
      const tasks = await Promise.all(ids.map((task) => client.readContract({ ...board, functionName: "get", args: [task] })));
      const paid = await scan(
        (fromBlock, toBlock) => client.getContractEvents({ ...board, eventName: "BountyPaid", args: { account: account.address }, fromBlock, toBlock }),
        network.fromBlock,
        latest,
      );
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

/** Briefs come from strangers, so the worker fetches only public names, never an address or a local network's name. */
function publicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || isIP(host) !== 0) return false;
  return host.includes(".") && !/(^|\.)localhost$|\.local$|\.internal$/.test(host);
}

async function download(uri: string, fetcher: typeof fetch): Promise<Uint8Array> {
  if (!URL.canParse(uri)) throw new PermanentError("The brief's URL is not valid");
  const url = new URL(uri);
  if (!publicHost(url.hostname)) throw new PermanentError(`The brief is on ${url.hostname}, which is not a public host`);
  const stop = new AbortController();
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) throw new Error(`The brief answered ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BRIEF_BYTES) {
      stop.abort();
      throw new PermanentError(`The brief is larger than ${MAX_BRIEF_BYTES / 1024} KB`);
    }
    chunks.push(chunk);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

/** Reads a brief and checks it against the hash on chain. Briefs are base64 data URIs or https URLs. */
export async function fetchBrief(uri: string, expected: Hex, fetcher: typeof fetch = fetch): Promise<string> {
  let bytes: Uint8Array;
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0 || !uri.slice(0, comma).endsWith(";base64")) throw new PermanentError("The brief's data URI is not base64");
    bytes = Uint8Array.from(Buffer.from(uri.slice(comma + 1), "base64"));
  } else if (uri.startsWith("https://")) {
    bytes = await download(uri, fetcher);
  } else {
    throw new PermanentError("The brief is neither a data URI nor an https URL");
  }
  if (bytes.byteLength > MAX_BRIEF_BYTES) throw new PermanentError(`The brief is larger than ${MAX_BRIEF_BYTES / 1024} KB`);
  if (keccak256(bytes).toLowerCase() !== expected.toLowerCase()) throw new PermanentError("The brief does not match its hash on chain");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PermanentError("The brief is not UTF-8 text");
  }
}
