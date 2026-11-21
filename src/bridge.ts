import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

import { reason, RECEIPT_MS } from "./chain.js";
import { cli } from "./invoked.js";
import { chainOf, parentChainOf, rpcTransport, type Network } from "./network.js";
import { grouped } from "./standing.js";

export type Asset = "eth" | "stake" | "bounty";

const inboxAbi = parseAbi([
  "function depositEth() payable returns (uint256)",
  "function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) view returns (uint256)",
]);
const routerAbi = parseAbi([
  "function getGateway(address token) view returns (address)",
  "function calculateL2TokenAddress(address token) view returns (address)",
  "function outboundTransferCustomRefund(address token, address refundTo, address to, uint256 amount, uint256 maxGas, uint256 gasPriceBid, bytes data) payable returns (bytes)",
]);
const gatewayAbi = parseAbi([
  "function getOutboundCalldata(address token, address from, address to, uint256 amount, bytes data) view returns (bytes)",
  "function counterpartGateway() view returns (address)",
  "event DepositInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _sequenceNumber, uint256 _amount)",
  "event DepositFinalized(address indexed l1Token, address indexed _from, address indexed _to, uint256 _amount)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** Gas for the token's arrival on BrainChain; what it does not use comes back to the worker there. */
const DEPOSIT_GAS = 300_000n;

const stakingTokenAbi = parseAbi(["function token() view returns (address)"]);

/** About a day of Robinhood Chain blocks, which the gateway's own logs are read over with one request. */
const DEPOSIT_WINDOW_BLOCKS = 750_000n;

/** A deposit that was sent and not confirmed: it can still land, so what it carries may be on its way to BrainChain. */
export class DepositSent extends Error {}

/** A stake-token deposit from the wallet to itself, by its time in seconds: sent on the parent chain, or arrived on BrainChain. */
export interface StakeDeposit {
  tx: Hex;
  amount: bigint;
  at: number;
}

/** What a deposit needs from the parent chain. */
export interface BridgeChain {
  account: Address;
  /** How many of the wallet's transactions on the parent chain are sent and not yet mined. */
  unmined(): Promise<number>;
  /** The worker's ETH on the parent chain, which pays the deposit and its gas. */
  parentEth(): Promise<bigint>;
  tokenBalance(asset: Exclude<Asset, "eth">): Promise<bigint>;
  /** The ETH a token deposit sends along to pay for its arrival. */
  arrivalCost(asset: Exclude<Asset, "eth">, amount: bigint): Promise<bigint>;
  depositEth(amount: bigint): Promise<Hex>;
  /** Approves the token's gateway when needed and sends the deposit; `sent` hears its hash before it is mined. */
  depositToken(asset: Exclude<Asset, "eth">, amount: bigint, value: bigint, sent?: (hash: Hex) => void): Promise<Hex>;
  /** What the parent chain's stake token becomes on BrainChain, and what the staking contract takes there. */
  stakeTokens(): Promise<{ bridged: Address; staked: Address }>;
  /** Stake-token deposits this wallet sent itself in about the last day, and every one that arrived on BrainChain. */
  stakeDeposits(): Promise<{ sent: StakeDeposit[]; arrived: StakeDeposit[] }>;
  /** Where a transaction sent from this wallet is: in a block, waiting to be mined, or unknown to the RPC. */
  transactionState(hash: Hex): Promise<"mined" | "pending" | "unknown">;
}

export function createBridgeChain(network: Network, account: PrivateKeyAccount, receiptMs = RECEIPT_MS): BridgeChain {
  const bridge = network.bridge;
  if (!bridge) throw new Error(`${network.name} has no bridge from a parent chain`);
  const parent = parentChainOf(bridge);
  const read = createPublicClient({ chain: parent, transport: rpcTransport(bridge.rpc) });
  const wallet = createWalletClient({ account, chain: parent, transport: rpcTransport(bridge.rpc) });
  const child = createPublicClient({ chain: chainOf(network), transport: rpcTransport(network.rpc) });
  const token = (asset: Exclude<Asset, "eth">): Address => {
    const address = bridge.tokens?.[asset];
    if (!address) throw new Error(`${network.name}'s ${asset} token is not bridged from ${bridge.name}`);
    return address;
  };
  const wait = async (hash: Hex, deposit = false) => {
    const receipt = await read.waitForTransactionReceipt({ hash, timeout: receiptMs }).catch((error: unknown) => {
      if (!deposit) throw error;
      // Sent is not lost: the deposit can still land, and what reaches BrainChain comes back only through the seven-day withdrawal.
      throw new DepositSent(
        `The deposit was sent on ${bridge.name} (${hash}) and could not be confirmed (${reason(error).replace(/\.$/, "")}). It can still land, so check it before running bridge again: another run sends another deposit.`,
      );
    });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on ${bridge.name}`);
    return hash;
  };
  const gateway = (address: Address) => read.readContract({ address: bridge.router, abi: routerAbi, functionName: "getGateway", args: [address] });

  return {
    account: account.address,
    async unmined() {
      const [pending, latest] = await Promise.all([read.getTransactionCount({ address: account.address, blockTag: "pending" }), read.getTransactionCount({ address: account.address })]);
      return pending - latest;
    },
    parentEth: () => read.getBalance({ address: account.address }),
    async stakeTokens() {
      const [bridged, staked] = await Promise.all([
        read.readContract({ address: bridge.router, abi: routerAbi, functionName: "calculateL2TokenAddress", args: [token("stake")] }),
        child.readContract({ address: network.contracts.staking, abi: stakingTokenAbi, functionName: "token" }),
      ]);
      return { bridged, staked };
    },
    async stakeDeposits() {
      const stake = token("stake");
      const parentGateway = await gateway(stake);
      const [childGateway, head] = await Promise.all([read.readContract({ address: parentGateway, abi: gatewayAbi, functionName: "counterpartGateway" }), read.getBlockNumber()]);
      const self = account.address;
      const [initiated, finalized] = await Promise.all([
        read.getLogs({ address: parentGateway, event: gatewayAbi[2], args: { _from: self, _to: self }, fromBlock: head > DEPOSIT_WINDOW_BLOCKS ? head - DEPOSIT_WINDOW_BLOCKS : 0n, toBlock: head }),
        // BrainChain makes a block only for a transaction, so its whole history is one small request.
        child.getLogs({ address: childGateway, event: gatewayAbi[3], args: { l1Token: stake, _from: self, _to: self }, fromBlock: 0n }),
      ]);
      const times = async (client: typeof read | typeof child, blocks: bigint[]) => {
        const unique = [...new Set(blocks)];
        const found = await Promise.all(unique.map((blockNumber) => client.getBlock({ blockNumber })));
        return new Map(unique.map((n, i) => [n, Number(found[i]!.timestamp)]));
      };
      const ours = initiated.filter((log) => same(log.args.l1Token!, stake));
      const [sentAt, arrivedAt] = await Promise.all([times(read, ours.map((l) => l.blockNumber)), times(child, finalized.map((l) => l.blockNumber))]);
      return {
        sent: ours.map((log) => ({ tx: log.transactionHash, amount: log.args._amount!, at: sentAt.get(log.blockNumber)! })),
        arrived: finalized.map((log) => ({ tx: log.transactionHash, amount: log.args._amount!, at: arrivedAt.get(log.blockNumber)! })),
      };
    },
    async transactionState(hash) {
      if (await read.getTransactionReceipt({ hash }).catch(() => undefined)) return "mined";
      return (await read.getTransaction({ hash }).catch(() => undefined)) ? "pending" : "unknown";
    },
    tokenBalance: (asset) => read.readContract({ address: token(asset), abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    async arrivalCost(asset, amount) {
      const address = token(asset);
      const calldata = await read.readContract({
        address: await gateway(address),
        abi: gatewayAbi,
        functionName: "getOutboundCalldata",
        args: [address, account.address, account.address, amount, "0x"],
      });
      const block = await read.getBlock();
      const baseFee = block.baseFeePerGas ?? (await read.getGasPrice());
      const submission = await read.readContract({
        address: bridge.inbox,
        abi: inboxAbi,
        functionName: "calculateRetryableSubmissionFee",
        args: [BigInt((calldata.length - 2) / 2), baseFee],
      });
      // Three times the quoted submission fee rides out a base fee that moves before the deposit lands; the rest is refunded on BrainChain.
      return submission * 3n + DEPOSIT_GAS * ((await child.getGasPrice()) * 2n);
    },
    depositEth: async (amount) => wait(await wallet.writeContract({ address: bridge.inbox, abi: inboxAbi, functionName: "depositEth", value: amount }), true),
    async depositToken(asset, amount, value, sent) {
      const address = token(asset);
      const spender = await gateway(address);
      // Ahead of the approval, so a refusal has sent nothing at all.
      const gasPriceBid = (await child.getGasPrice()) * 2n;
      const maxSubmissionCost = value - DEPOSIT_GAS * gasPriceBid;
      if (maxSubmissionCost <= 0n) throw new Error(`The gas price on ${network.name} moved after this deposit was priced, so the ETH set aside no longer pays for its arrival. Nothing was sent. Run the command again.`);
      const allowance = await read.readContract({ address, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
      if (allowance < amount) await wait(await wallet.writeContract({ address, abi: erc20Abi, functionName: "approve", args: [spender, amount] }));
      const data = encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [maxSubmissionCost, "0x"]);
      const hash = await wallet.writeContract({
        address: bridge.router,
        abi: routerAbi,
        functionName: "outboundTransferCustomRefund",
        args: [address, account.address, account.address, amount, DEPOSIT_GAS, gasPriceBid, data],
        value,
      });
      sent?.(hash);
      return wait(hash, true);
    },
  };
}

/**
 * What is wrong with this release's stake token, or undefined when the token
 * it names on the parent chain bridges to the one the staking contract takes.
 * A token that moves to new contracts, as $BRAIN did on 17 November 2026,
 * leaves a release that names the old one buying and bridging what nothing
 * stakes.
 */
export async function stakeProblem(network: Network, chain: Pick<BridgeChain, "stakeTokens">): Promise<string | undefined> {
  const parent = network.bridge?.tokens?.stake;
  if (!parent) return `${network.name}'s stake token is not bridged from a parent chain`;
  let tokens: { bridged: Address; staked: Address };
  try {
    tokens = await chain.stakeTokens();
  } catch (error) {
    return `Could not read which token the staking contract takes (${reason(error).replace(/\.$/, "")}), so the stake token was not checked`;
  }
  const { stakeToken } = network.contracts;
  if (same(tokens.bridged, stakeToken) && same(tokens.staked, stakeToken)) return undefined;
  return (
    `This release of brainchain-worker names ${parent} as ${network.stakeSymbol} on ${network.bridge!.name}, which the bridge turns into ${tokens.bridged} on ${network.name}, ` +
    `and the staking contract takes ${tokens.staked}. Buying or bridging it would bring a token nothing stakes. Update with npx brainchain-worker@latest`
  );
}

/** The stake deposits sent that no arrival accounts for, matched by amount, oldest first, each arrival once. */
export function unarrived(sent: StakeDeposit[], arrived: StakeDeposit[]): StakeDeposit[] {
  // An arrival is stamped by BrainChain's clock and a deposit by the parent chain's, which can differ by a little.
  const SLACK_SEC = 120;
  const left = [...arrived].sort((a, b) => a.at - b.at);
  return [...sent]
    .sort((a, b) => a.at - b.at)
    .filter((deposit) => {
      const i = left.findIndex((arrival) => arrival.amount === deposit.amount && arrival.at >= deposit.at - SLACK_SEC);
      if (i < 0) return true;
      left.splice(i, 1);
      return false;
    });
}

/** What buy-stake saved of its last swap and of the last stake deposit, in seconds since the epoch. */
export interface StakeMoves {
  swap?: { tx: Hex; at: number };
  deposit?: { tx: Hex; amount: bigint; at: number };
}

/** A transaction the RPC does not know may still be on its way to it this long after it was sent. */
const UNSEEN_SEC = 600;
const DEPOSIT_DAY_SEC = 86_400;

/**
 * Why buying the stake now could buy it twice, or undefined: a transaction of
 * this wallet's still unmined, the last swap not yet seen, or a stake deposit
 * of the last day that has not arrived on BrainChain, where `join` cannot see
 * it yet.
 */
export async function stakeInFlight(
  network: Network,
  chain: Pick<BridgeChain, "unmined" | "stakeDeposits" | "transactionState">,
  saved: StakeMoves,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string | undefined> {
  const parent = network.bridge!.name;
  const ago = (at: number) => {
    const minutes = Math.max(0, Math.floor((nowSec - at) / 60));
    return minutes === 0 ? "less than a minute ago" : minutes === 1 ? "a minute ago" : minutes < 120 ? `${minutes} minutes ago` : `${Math.round(minutes / 60)} hours ago`;
  };
  const brains = (amount: bigint) => `${grouped(amount, 18)} ${network.stakeSymbol}`;
  const last = [
    ...(saved.swap ? [{ what: "the swap", ...saved.swap }] : []),
    ...(saved.deposit ? [{ what: `the deposit of ${brains(saved.deposit.amount)}`, ...saved.deposit }] : []),
  ].sort((a, b) => b.at - a.at);
  if ((await chain.unmined()) > 0) {
    const named = last[0] && nowSec - last[0].at < DEPOSIT_DAY_SEC ? `, which may be ${last[0].what} it sent ${ago(last[0].at)} (${last[0].tx})` : "";
    return `This wallet has a transaction on ${parent} that is not mined yet${named}, and buying now could buy the ${network.stakeSymbol} twice. Run buy-stake again once it is mined`;
  }
  for (const move of last) {
    if (nowSec - move.at >= UNSEEN_SEC || (await chain.transactionState(move.tx)) !== "unknown") continue;
    return `${move.what[0]!.toUpperCase()}${move.what.slice(1)} this wallet sent ${ago(move.at)} (${move.tx}) is not on ${parent} yet, and buying now could buy the ${network.stakeSymbol} twice. Run buy-stake again once it is mined, or in ${Math.ceil((UNSEEN_SEC - (nowSec - move.at)) / 60)} minutes if it never is`;
  }
  let deposits: { sent: StakeDeposit[]; arrived: StakeDeposit[] };
  try {
    deposits = await chain.stakeDeposits();
  } catch (error) {
    if (!saved.deposit || nowSec - saved.deposit.at >= DEPOSIT_DAY_SEC) return undefined;
    return `Could not check whether the deposit of ${brains(saved.deposit.amount)} sent ${ago(saved.deposit.at)} (${saved.deposit.tx}) has arrived on ${network.name} (${reason(error).replace(/\.$/, "")}), and buying before it does could buy it twice. Run buy-stake again in a minute`;
  }
  const waiting = unarrived(deposits.sent, deposits.arrived);
  const latest = waiting.at(-1);
  if (!latest) return undefined;
  return (
    `A deposit of ${brains(latest.amount)} from this wallet, sent ${ago(latest.at)} (${latest.tx}), has not arrived on ${network.name} yet, and buying now would buy it again. ` +
    `Deposits arrive in about a minute: run buy-stake again once ${cli("status")} shows it`
  );
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The amount flag's decimals and the name the worker sees. */
export function assetOf(network: Network, asset: Asset): { decimals: number; symbol: string } {
  if (asset === "eth") return { decimals: 18, symbol: "ETH" };
  return asset === "stake" ? { decimals: 18, symbol: network.stakeSymbol } : { decimals: 6, symbol: network.bountySymbol };
}

/**
 * Moves ETH, the stake token or the bounty token from the parent chain to the
 * worker's own address on BrainChain, where it arrives in about a minute.
 */
export async function bridge(
  network: Network,
  chain: BridgeChain,
  options: {
    asset: Asset;
    amount: string;
    dry: boolean;
    log: (line: string) => void;
    /** Hears a stake deposit's hash once it is sent. */
    sent?: (deposit: { tx: Hex; amount: bigint }) => void;
  },
): Promise<void> {
  const { asset, dry, log } = options;
  const parent = network.bridge;
  if (!parent) throw new Error(`${network.name} has no bridge from a parent chain`);
  const { decimals, symbol } = assetOf(network, asset);
  const amount = parseUnits(options.amount, decimals);
  if (amount <= 0n) throw new Error("the amount must be above zero");
  // Token amounts are grouped as status shows them; ETH amounts are small.
  const shown = asset === "eth" ? `${formatUnits(amount, decimals)} ${symbol}` : `${grouped(amount, decimals)} ${symbol}`;
  const settled = async () => {
    if ((await chain.unmined()) > 0) {
      throw new Error(`This wallet has a transaction on ${parent.name} that is not mined yet, which may be an earlier deposit, and another run would send another. Nothing was sent; run bridge again once it is mined.`);
    }
  };

  let eth: bigint;
  try {
    eth = await chain.parentEth();
  } catch (error) {
    throw new Error(`could not read the wallet on ${parent.name}: ${reason(error)}`);
  }
  // The plan comes first and every shortfall after it, so a dry run says all a wallet still needs at once.
  const refuse = (short: string[]) => {
    if (short.length > 0) throw new Error([...short, ...(dry ? ["dry run: nothing sent"] : [])].join("\n"));
  };
  if (asset === "eth") {
    const gas = parseUnits("0.00002", 18);
    log(`bridging ${shown} from ${parent.name} to ${chain.account} on ${network.name}`);
    refuse(eth < amount + gas ? [`${chain.account} holds ${formatEther(eth)} ETH on ${parent.name}; ${shown} plus gas is needed. ${parent.gas}`] : []);
    if (dry) return log("dry run: nothing sent");
    await settled();
    const tx = await chain.depositEth(amount);
    return log(`sent, arrives on ${network.name} in about a minute: ${tx}`);
  }

  if (asset === "stake") {
    const problem = await stakeProblem(network, chain);
    if (problem) throw new Error(`${problem}. Nothing was sent.`);
  }
  const [held, value] = await Promise.all([chain.tokenBalance(asset), chain.arrivalCost(asset, amount)]);
  const needs = value + parseUnits("0.0001", 18);
  log(
    `bridging ${shown} from ${parent.name} to ${chain.account} on ${network.name} (sending ${formatEther(value)} ETH for its arrival, the unused part refunded there; ` +
      `with gas, the wallet needs about ${formatEther(needs)} ETH on ${parent.name})`,
  );
  refuse([
    ...(held < amount ? [`${chain.account} holds ${grouped(held, decimals)} ${symbol} on ${parent.name}, ${grouped(amount - held, decimals)} short of ${shown}`] : []),
    ...(eth < needs ? [`${chain.account} holds ${formatEther(eth)} ETH on ${parent.name}; about ${formatEther(needs)} ETH is needed to pay the deposit's arrival and gas. ${parent.gas}`] : []),
  ]);
  if (dry) return log("dry run: nothing sent");
  await settled();
  const tx = await chain.depositToken(asset, amount, value, asset === "stake" ? (hash) => options.sent?.({ tx: hash, amount }) : undefined);
  log(`sent, arrives on ${network.name} in about a minute: ${tx}`);
}
