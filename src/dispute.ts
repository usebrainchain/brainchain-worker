import { createPublicClient, createWalletClient, formatUnits, parseAbi, type Address, type Hex, type PrivateKeyAccount } from "viem";

import { brainchainTransport, erc20Abi, RECEIPT_MS, Status } from "./chain.js";
import { chainOf, type Network } from "./network.js";

/** TaskBoard statuses from set 3.5.0 on: a ruling that waits out its appeal window, and one under appeal. */
export const { Ruled, Appealed } = Status;

const boardAbi = parseAbi([
  "function get(uint256 id) view returns ((address poster, uint128 bounty, uint64 deadline, uint8 status, bool accepted, bool disputed, bool disputedByModel, bytes32 model, bytes32 briefHash, bytes32 resultHash, uint64 submittedAt, uint64 gradedAt, uint64 disputedAt, uint64 postedAt, address payee, address feeRecipient, uint16 feeBps, uint16 hireThresholdBps, uint16 gradeThresholdBps, uint16 ruleThresholdBps, uint64 gradeWindow, uint64 disputeWindow, uint64 ruleWindow))",
  "function appealOf(uint256 id) view returns ((uint64 window, uint16 bondBps, uint64 ruledAt, bool pays, bool confident, address appellant, uint128 bond, uint64 appealedAt))",
  "function appealBond(uint256 id) view returns (uint128)",
  "function dispute(uint256 id)",
  "function appeal(uint256 id)",
]);

export interface DisputeTask {
  status: number;
  poster: Address;
  payee: Address;
  accepted: boolean;
  disputed: boolean;
  gradedAt: bigint;
  disputeWindow: bigint;
  ruleWindow: bigint;
}

export interface DisputeChain {
  account: Address;
  now(): Promise<bigint>;
  task(id: bigint): Promise<DisputeTask>;
  /** Set 3.5.0 and later only; earlier boards have no appeals. */
  appealOf(id: bigint): Promise<{ window: bigint; ruledAt: bigint; pays: boolean }>;
  appealBond(id: bigint): Promise<bigint>;
  bountyBalance(): Promise<bigint>;
  approveBounty(amount: bigint): Promise<void>;
  dispute(id: bigint): Promise<Hex>;
  appeal(id: bigint): Promise<Hex>;
}

export function createDisputeChain(network: Network, account: PrivateKeyAccount): DisputeChain {
  const chain = chainOf(network);
  const transport = brainchainTransport(network);
  const client = createPublicClient({ chain, transport, pollingInterval: 1_000 });
  const wallet = createWalletClient({ account, chain, transport });
  const board = { address: network.contracts.taskBoard, abi: boardAbi } as const;
  const token = { address: network.contracts.bountyToken, abi: erc20Abi } as const;

  async function send(functionName: "dispute" | "appeal", id: bigint): Promise<Hex> {
    const hash = await wallet.writeContract({ ...board, functionName, args: [id] });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_MS });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
    return hash;
  }

  return {
    account: account.address,
    async now() {
      const block = await client.getBlock();
      const wall = BigInt(Math.floor(Date.now() / 1000));
      return block.timestamp > wall ? block.timestamp : wall;
    },
    task: (id) => client.readContract({ ...board, functionName: "get", args: [id] }),
    appealOf: (id) => client.readContract({ ...board, functionName: "appealOf", args: [id] }),
    appealBond: (id) => client.readContract({ ...board, functionName: "appealBond", args: [id] }),
    bountyBalance: () => client.readContract({ ...token, functionName: "balanceOf", args: [account.address] }),
    async approveBounty(amount) {
      const current = await client.readContract({ ...token, functionName: "allowance", args: [account.address, board.address] });
      if (current >= amount) return;
      const hash = await wallet.writeContract({ ...token, functionName: "approve", args: [board.address, amount] });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_MS });
      if (receipt.status !== "success") throw new Error(`Approval ${hash} reverted`);
    },
    dispute: (id) => send("dispute", id),
    appeal: (id) => send("appeal", id),
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const at = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace(/\.000Z$/, "Z");

/** Disputes a grade on a task the worker delivered, within the dispute window. */
export async function dispute(network: Network, chain: DisputeChain, id: bigint, log: (line: string) => void): Promise<void> {
  const [task, now] = await Promise.all([chain.task(id), chain.now()]);
  if (task.status === 0) throw new Error(`There is no task ${id} on ${network.name}.`);
  if (!same(task.payee, chain.account) && !same(task.poster, chain.account)) {
    throw new Error(`Only the poster or the account that delivered task ${id} can dispute it, and ${chain.account} is neither.`);
  }
  if (task.status !== Status.Graded || task.disputed) throw new Error(`Task ${id} is not waiting on a dispute: a grade can be disputed once, while it is graded and unsettled.`);
  const closes = task.gradedAt + task.disputeWindow;
  if (now > closes) throw new Error(`The dispute window for task ${id} closed at ${at(closes)}.`);
  const tx = await chain.dispute(id);
  log(`Disputed the grade on task ${id} (${task.accepted ? "it accepted the work" : "it rejected the work"}): ${tx}`);
  log(`Jev rules within ${task.ruleWindow / 3_600n} hours. A confident ruling decides; otherwise the grade stands.`);
}

/** Appeals the ruling on a task, as the side it went against, with the bond the board fixed when the task was posted. */
export async function appeal(network: Network, chain: DisputeChain, id: bigint, log: (line: string) => void): Promise<void> {
  const [task, now] = await Promise.all([chain.task(id), chain.now()]);
  if (task.status === 0) throw new Error(`There is no task ${id} on ${network.name}.`);
  if (task.status === Status.Disputed) throw new Error(`Task ${id} is still waiting for Jev's ruling. Appeal once it is ruled.`);
  if (task.status === Appealed) throw new Error(`Task ${id} is already under appeal; a ruling can be appealed once.`);
  if (task.status !== Ruled) throw new Error(`Task ${id} has no ruling open to appeal.`);
  const terms = await chain.appealOf(id);
  const appellant = terms.pays ? task.poster : task.payee;
  if (!same(appellant, chain.account)) {
    throw new Error(`The ruling on task ${id} ${terms.pays ? "pays the model, so only the poster" : "refunds the poster, so only the account that delivered"} can appeal it.`);
  }
  const closes = terms.ruledAt + terms.window;
  if (now > closes) throw new Error(`The appeal window for task ${id} closed at ${at(closes)}.`);
  const [bond, balance] = await Promise.all([chain.appealBond(id), chain.bountyBalance()]);
  const amount = `${formatUnits(bond, 6)} ${network.bountySymbol}`;
  if (balance < bond) throw new Error(`The appeal bond is ${amount}, and the worker holds ${formatUnits(balance, 6)}. Bridge more with \`npx brainchain-worker bridge --bounty <amount>\`.`);
  await chain.approveBounty(bond);
  const tx = await chain.appeal(id);
  log(`Appealed the ruling on task ${id} with a ${amount} bond: ${tx}`);
  log(`Jev rules again within ${task.ruleWindow / 3_600n} hours. The bond comes back unless Jev confidently rules the same way.`);
}
