// `buy-stake`: a worker that holds ETH or USDG on Robinhood Chain buys exactly the BRAIN join still needs, through 0x.
// The quote is bought from 0x's keyless gateway for 0.01 USDC on Base, and nothing is signed on Robinhood Chain until
// 0x's signature on it verifies, its calldata does only this swap for this wallet, a simulation brings the BRAIN, and
// the cost is within the loss limit `fund` applies to the stake token.

import { ALLOWANCE_HOLDER, fetchZeroxKeys, NATIVE, readSettlers, verifyQuote, type Quote, type Settlers, type ZeroxKey } from "brainchain-verify/zerox";
import { createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, parseEther, type Address, type Hex, type PrivateKeyAccount } from "viem";

import { DepositSent } from "./bridge.js";
import { reason, RECEIPT_MS } from "./chain.js";
import { cli } from "./invoked.js";
import { parentChainOf, rpcTransport, type Network } from "./network.js";
import { FIXED_LOSS_USD, MAX_STAKE_LOSS, NATIVE as RELAY_NATIVE } from "./relay.js";
import { PARENT_ETH_KEEP } from "./solana.js";
import { PROBE_CODE, probeAbi } from "./probe.js";
import { grouped } from "./standing.js";
import type { PaidQuote } from "./zerox.js";

export type Pay = "eth" | "usdg";

/** Gas for an approval, which a USDG sale needs once. */
const APPROVE_GAS = 60_000n;
/** ETH the simulation lends a wallet that lacks it, so a dry run still shows what the swap does. */
const LENT = parseEther("10");

export interface Swap {
  to: Address;
  data: Hex;
  value: bigint;
  gas?: bigint;
}

/** What buy-stake reads and sends on the parent chain, and reads on the payment chain. */
export interface BuyChain {
  account: Address;
  eth(): Promise<bigint>;
  balance(token: Address): Promise<bigint>;
  allowance(token: Address, spender: Address): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  /** The worker's USDC where it pays for quotes. */
  paymentBalance(): Promise<bigint>;
  settlers(): Promise<Settlers>;
  /** Runs the swap on the latest block, after the approval when given, and sends nothing: what it takes and what it brings. */
  simulate(swap: Swap, sold: Address, bought: Address, options?: { approve?: bigint; lend?: bigint }): Promise<{ spent: bigint; gained: bigint }>;
  approve(token: Address, spender: Address, amount: bigint): Promise<Hex>;
  /** Sends the swap and waits for it; a revert throws. */
  send(swap: Swap): Promise<Hex>;
}

export interface BuyDeps {
  chain: BuyChain;
  /** What join needs on BrainChain, and what the wallet holds there. */
  needs(): Promise<{ need: bigint; held: bigint }>;
  stakeProblem(): Promise<string | undefined>;
  /** A token's price in USD, by its address as Relay names it. */
  price(token: string): Promise<number>;
  quote(query: Record<string, string>): Promise<PaidQuote>;
  keys?(): Promise<ZeroxKey[]>;
  bridge(amount: bigint): Promise<void>;
  now?(): number;
}

export interface BuyOptions {
  pay: Pay;
  dry: boolean;
  yes: boolean;
  ask?: (question: string) => Promise<string>;
  log: (line: string) => void;
}

/** A figure for a person: at most six decimals, rounded up for a ceiling so it never reads lower than it is. */
function figure(amount: bigint, decimals: number, up = false): string {
  const cut = decimals > 6 ? 10n ** BigInt(decimals - 6) : 1n;
  const rounded = up ? ((amount + cut - 1n) / cut) * cut : (amount / cut) * cut;
  return formatUnits(rounded, decimals);
}

const usd = (value: number) => value.toFixed(2);
const yes = (answer: string) => ["y", "yes"].includes(answer.trim().toLowerCase());

export async function buyStake(network: Network, deps: BuyDeps, options: BuyOptions): Promise<void> {
  const { chain } = deps;
  const { log } = options;
  const zerox = network.zerox;
  const parent = network.bridge;
  const brain = parent?.tokens?.stake;
  const usdgToken = parent?.tokens?.bounty;
  if (!zerox || !parent || !brain || !usdgToken) {
    throw new Error(`buy-stake works on mainnet only, where BRAIN trades on Robinhood Chain; on ${network.name}, join claims the ${network.stakeSymbol} from the faucet`);
  }
  if (!options.dry && !options.yes && !options.ask) throw new Error("There is no terminal to confirm on. Run again with --yes to buy without asking, or with --dry to see the quote.");
  const sell =
    options.pay === "eth"
      ? { token: NATIVE, relay: RELAY_NATIVE, symbol: "ETH", decimals: 18 }
      : { token: usdgToken, relay: usdgToken, symbol: network.bountySymbol, decimals: 6 };
  const sells = (amount: bigint, up = false) => `${figure(amount, sell.decimals, up)} ${sell.symbol}`;
  const brains = (amount: bigint) => `${grouped(amount, 18)} ${network.stakeSymbol}`;
  const quotePrice = `${formatUnits(zerox.payment.price, 6)} USDC`;

  const pinned = await deps.stakeProblem();
  if (pinned) throw new Error(`${pinned}. Nothing was paid.`);
  const [{ need, held }, onParent] = await Promise.all([deps.needs(), chain.balance(brain)]);
  if (need === 0n) return log(`This worker's stake is at the minimum and it applies for nothing, so there is no ${network.stakeSymbol} to buy.`);
  const missing = need > held ? need - held : 0n;
  if (missing === 0n) return log(`The wallet holds the ${brains(need)} join needs on ${network.name}. Run ${cli("join")}.`);
  const fromParent = onParent < missing ? onParent : missing;
  const amount = missing - fromParent;
  const bridgeCommand = (total: bigint) => cli(`bridge --stake ${formatUnits(total, 18)}`);
  if (amount === 0n) {
    return log(`The wallet already holds ${brains(onParent)} on ${parent.name}, which covers the ${brains(missing)} join still needs. Move it with ${bridgeCommand(missing)}, then run ${cli("join")}.`);
  }
  const holds = `${brains(held)} on ${network.name}${onParent > 0n ? ` and ${brains(onParent)} on ${parent.name}` : ""}`;
  log(`join needs ${brains(need)} on ${network.name}. ${chain.account} holds ${holds}, so this buys ${brains(amount)} with ${sell.symbol} on ${parent.name}, through 0x.`);

  const paidWith = await chain.paymentBalance().catch((error: unknown) => {
    throw new Error(`Could not read the wallet's USDC on ${zerox.payment.name} (${reason(error).replace(/\.$/, "")}). Nothing was paid.`);
  });
  if (paidWith < zerox.payment.price) {
    throw new Error(
      `buy-stake pays 0x ${quotePrice} on ${zerox.payment.name} for its quote, from the worker's own key, and ${chain.account} holds ${formatUnits(paidWith, 6)} USDC there. ` +
        `Send that address at least ${quotePrice} on ${zerox.payment.name}. Nothing was paid.`,
    );
  }
  let sellUsd: number;
  let brainUsd: number;
  try {
    [sellUsd, brainUsd] = await Promise.all([deps.price(sell.relay), deps.price(brain)]);
  } catch (error) {
    throw new Error(`Could not read prices from Relay, which the loss limit is measured against (${reason(error).replace(/\.$/, "")}). Nothing was paid.`);
  }
  const worth = Number(formatUnits(amount, 18)) * brainUsd;
  const [eth, token, gasPrice] = await Promise.all([chain.eth(), options.pay === "usdg" ? chain.balance(sell.token) : undefined, chain.gasPrice()]);
  const balance = token ?? eth;
  // A wallet that cannot pay even BRAIN's own price could not take any quote, so it is told before a quote is bought.
  const spendable = options.pay === "eth" ? (balance > PARENT_ETH_KEEP ? balance - PARENT_ETH_KEEP : 0n) : balance;
  if (!options.dry && Number(formatUnits(spendable, sell.decimals)) * sellUsd < worth) {
    throw new Error(
      `${chain.account} holds ${sells(balance)} on ${parent.name}. ${brains(amount)} is worth ${usd(worth)} USD at BRAIN's price, ` +
        `about ${(worth / sellUsd).toFixed(sell.decimals === 6 ? 2 : 6)} ${sell.symbol}, before 0x's fee and the market's cost. Nothing was paid.`,
    );
  }

  log(options.dry ? `Dry run: buys one quote from 0x for ${quotePrice} on ${zerox.payment.name}, and sends nothing else.` : `Buying a quote from 0x for ${quotePrice} on ${zerox.payment.name}...`);
  const intent = { chainId: parent.chainId, taker: chain.account, sellToken: sell.token, buyToken: brain, buyAmount: amount };
  const paid = await deps.quote({ chainId: String(parent.chainId), sellToken: sell.token, buyToken: brain, buyAmount: amount.toString(), taker: chain.account });
  if (paid.payment) log(`Paid 0x ${quotePrice} on ${zerox.payment.name}: ${paid.payment}`);
  const spentQuote = `The quote's ${quotePrice} is spent`;
  const settlers = () => chain.settlers();
  let report = await verifyQuote(paid.response, paid.url, intent, { settlers, ...(deps.now ? { now: deps.now } : {}) });
  // 0x rotates its key and lists a new one on its docs page before signing with it, so a key this build does not carry is looked up there.
  if (report.checks.find((c) => c.status === "fail")?.name === "zerox-key" && deps.keys) {
    const keys = await deps.keys().catch(() => undefined);
    if (keys) report = await verifyQuote(paid.response, paid.url, intent, { settlers, keys, ...(deps.now ? { now: deps.now } : {}) });
  }
  const failed = report.checks.find((c) => c.status === "fail");
  if (failed || !report.quote) throw new Error(`0x's quote was refused before anything was signed: ${failed?.message ?? "it could not be read"}. ${spentQuote}; nothing else was sent.`);
  const quote: Quote = report.quote;
  const most = quote.maxSellAmount!;
  const swap: Swap = { to: quote.transaction.to, data: quote.transaction.data, value: quote.transaction.value, ...(quote.transaction.gas ? { gas: quote.transaction.gas } : {}) };
  const holder = ALLOWANCE_HOLDER[parent.chainId]!;
  const allowance = options.pay === "usdg" ? await chain.allowance(sell.token, holder) : most;
  const approves = allowance < most;

  const covered = options.pay === "eth" ? eth >= most : balance >= most;
  const simulated = await simulateBuy(chain, swap, sell.token, brain, { approves, most, wants: amount, covered, eth: options.pay === "eth" });
  if (typeof simulated === "string") throw new Error(`${simulated}. ${spentQuote}; nothing else was sent.`);
  const spent = simulated?.spent ?? quote.estimatedNetSellAmount ?? most;
  const cost = costOf(spent, sell.decimals, sellUsd, worth);
  const signedAgo = report.signature.created === undefined ? "" : `, signed ${Math.max(0, Math.round((deps.now ?? Date.now)() / 1000) - report.signature.created)} seconds ago`;
  const settler = report.decoded!.settler;
  const gas = ((swap.gas ?? 1_000_000n) + (approves ? APPROVE_GAS : 0n)) * gasPrice;
  log(
    [
      `0x quotes ${brains(amount)} for ${sells(spent)} (${usd(cost.inUsd)} USD)${simulated ? "" : ", as 0x estimates it"}, at most ${sells(most, true)}; what the swap does not use comes back in the same transaction.`,
      `  At Relay's price of ${brainUsd.toPrecision(3)} USD, ${brains(amount)} is worth ${usd(worth)} USD: the route costs ${(cost.share * 100).toFixed(1)}% more, 0x's 0.15% fee included, ` +
        `${cost.loss > cost.allowed ? "over" : "within"} the ${Math.round(MAX_STAKE_LOSS * 100)}% this command accepts.`,
      `  Checked: 0x's signature (key ${report.signature.keyid}${signedAgo}); the transaction calls 0x's AllowanceHolder ${short(holder)}, which lets Settler ${short(settler)}, the one 0x's registry names, take at most ${sells(most, true)}; it pays the BRAIN to ${short(chain.account)} and reverts below ${brains(amount)}.`,
      simulated
        ? `  Simulated on ${parent.name}${simulated.lent ? `, as if the wallet held the ${sell.symbol}` : ""}: it takes ${sells(simulated.spent)} and brings ${brains(simulated.gained)}.`
        : `  Not simulated: the wallet holds ${sells(balance)} of the ${sells(most, true)} the swap may take.`,
      `  Gas on ${parent.name}: about ${figure(gas, 18, true)} ETH for ${approves ? `an approval of ${sells(most, true)} to AllowanceHolder and the swap` : "the swap"}.`,
    ].join("\n"),
  );
  if (cost.loss > cost.allowed) {
    throw new Error(
      `The route costs ${usd(cost.loss)} USD more than the BRAIN is worth, ${(cost.share * 100).toFixed(1)}%, more than the ${usd(cost.allowed)} this command accepts (${Math.round(MAX_STAKE_LOSS * 100)}%, or ${usd(FIXED_LOSS_USD)} USD on a small buy). ` +
        `${spentQuote}; nothing else was sent. Try again later, or buy at ripples.run and use ${cli("bridge --stake")}.`,
    );
  }
  const keep = options.pay === "eth" ? most + gas + PARENT_ETH_KEEP : gas + PARENT_ETH_KEEP;
  const lacks = [
    ...(options.pay === "usdg" && balance < most ? [`${chain.account} holds ${sells(balance)} on ${parent.name}, and the swap may take up to ${sells(most, true)}.`] : []),
    ...(eth < keep
      ? [
          `${chain.account} holds ${figure(eth, 18)} ETH on ${parent.name}, and needs about ${figure(keep, 18, true)} ETH: ` +
            `${options.pay === "eth" ? `up to ${sells(most, true)} for the swap, ` : ""}${figure(gas, 18, true)} ETH for gas and ${formatUnits(PARENT_ETH_KEEP, 18)} ETH kept for the bridge's deposit.`,
        ]
      : []),
  ];
  if (options.dry) {
    for (const line of lacks) log(line);
    return log(`Dry run: ${quotePrice} paid for the quote, nothing else sent.`);
  }
  if (lacks.length > 0) throw new Error(`${lacks.join("\n")}\n${spentQuote}; nothing else was sent.`);
  if (!options.yes) {
    if (!yes(await options.ask!(`Buy ${brains(amount)} for at most ${sells(most, true)}? [y/N] `))) return log(`Nothing sent. ${spentQuote}.`);
  }

  if (approves) {
    log(`Approving ${sells(most, true)} for 0x's AllowanceHolder...`);
    await chain.approve(sell.token, holder, most);
  }
  // Again on the latest block, since the person may have taken a while to answer.
  const now = await simulateBuy(chain, swap, sell.token, brain, { approves: false, most, wants: amount, covered: true, eth: options.pay === "eth" });
  const left = approves ? " The approval stays, and AllowanceHolder lets only this wallet's own transactions use it." : "";
  if (typeof now === "string" || now === undefined) throw new Error(`${now ?? "The swap could not be simulated"}. Nothing was bought.${left}`);
  const again = costOf(now.spent, sell.decimals, sellUsd, worth);
  if (again.loss > again.allowed) throw new Error(`The price moved: the swap would now take ${sells(now.spent)}, ${(again.share * 100).toFixed(1)}% over BRAIN's price. Nothing was bought.${left}`);
  log(`Buying ${brains(amount)}...`);
  const before = await chain.balance(brain);
  const tx = await chain.send(swap);
  const after = await chain.balance(brain);
  log(`Bought ${brains(after > before ? after - before : 0n)} on ${parent.name}: ${tx}`);

  const total = fromParent + amount;
  const move = bridgeCommand(total);
  if (!options.yes && !yes(await options.ask!(`Move ${brains(total)} to ${network.name} now with ${move}? [y/N] `))) {
    return log(`The BRAIN stays on ${parent.name}. ${move} moves it, then ${cli("join")} stakes it.`);
  }
  try {
    await deps.bridge(total);
  } catch (error) {
    if (error instanceof DepositSent) throw error;
    throw new Error(`${reason(error).replace(/\.?$/, ".")} The BRAIN is on ${parent.name}; ${move} moves it.`);
  }
  log(`Once it arrives, ${cli("join")} stakes it.`);
}

/** What the swap costs over the BRAIN's worth at Relay's prices, and how much the loss limit allows. */
function costOf(spent: bigint, decimals: number, sellUsd: number, worth: number) {
  const inUsd = Number(formatUnits(spent, decimals)) * sellUsd;
  const loss = inUsd - worth;
  return { inUsd, loss, share: inUsd > 0 ? loss / inUsd : 0, allowed: Math.max(inUsd * MAX_STAKE_LOSS, FIXED_LOSS_USD) };
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

/**
 * The swap simulated, or why it cannot be sent. A wallet short of ETH is lent
 * it in the simulation; one short of USDG is not simulated, since a token's
 * balance has no general place to override.
 */
async function simulateBuy(
  chain: BuyChain,
  swap: Swap,
  sold: Address,
  bought: Address,
  how: { approves: boolean; most: bigint; wants: bigint; covered: boolean; eth: boolean },
): Promise<{ spent: bigint; gained: bigint; lent: boolean } | string | undefined> {
  if (!how.covered && !how.eth) return undefined;
  const lend = !how.covered ? swap.value + LENT : undefined;
  try {
    const result = await chain.simulate(swap, sold, bought, { ...(how.approves ? { approve: how.most } : {}), ...(lend ? { lend } : {}) });
    if (result.spent > how.most) return `The swap takes ${result.spent} when simulated, more than the ${how.most} its calldata allows`;
    if (result.gained < how.wants) return `The swap brings ${result.gained} when simulated, less than the ${how.wants} asked for`;
    return { ...result, lent: lend !== undefined };
  } catch (error) {
    return `0x's transaction fails when simulated on Robinhood Chain: ${reason(error).replace(/\.$/, "")}`;
  }
}

export function createBuyChain(network: Network, account: PrivateKeyAccount, receiptMs = RECEIPT_MS): BuyChain {
  const bridge = network.bridge;
  const zerox = network.zerox;
  if (!bridge || !zerox) throw new Error(`buy-stake works on mainnet only`);
  const chain = parentChainOf(bridge);
  const read = createPublicClient({ chain, transport: rpcTransport(bridge.rpc) });
  const wallet = createWalletClient({ account, chain, transport: rpcTransport(bridge.rpc) });
  const payment = createPublicClient({ transport: rpcTransport(zerox.payment.rpc) });
  const self = account.address;
  const wait = async (hash: Hex, swap = false) => {
    const receipt = await read.waitForTransactionReceipt({ hash, timeout: receiptMs }).catch((error: unknown) => {
      if (!swap) throw error;
      throw new Error(
        `The swap was sent on ${bridge.name} (${hash}) and could not be confirmed (${reason(error).replace(/\.$/, "")}). It can still land, so check it before running buy-stake again: another run buys more.`,
      );
    });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on ${bridge.name}`);
    return hash;
  };
  return {
    account: self,
    eth: () => read.getBalance({ address: self }),
    balance: (token) => read.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [self] }),
    allowance: (token, spender) => read.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [self, spender] }),
    gasPrice: () => read.getGasPrice(),
    paymentBalance: () => payment.readContract({ address: zerox.payment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [self] }),
    settlers: () => readSettlers(read),
    async simulate(swap, sold, gotten, options = {}) {
      const { data } = await read.call({
        to: self,
        data: encodeFunctionData({ abi: probeAbi, functionName: "probe", args: [sold, gotten, options.approve ?? 0n, swap.to, swap.value, swap.data] }),
        stateOverride: [{ address: self, code: PROBE_CODE, ...(options.lend === undefined ? {} : { balance: options.lend }) }],
      });
      const [spent, gained] = decodeFunctionResult({ abi: probeAbi, functionName: "probe", data: data ?? "0x" });
      return { spent, gained };
    },
    approve: async (token, spender, amount) => wait(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] })),
    send: async (swap) => wait(await wallet.sendTransaction({ to: swap.to, data: swap.data, value: swap.value, ...(swap.gas ? { gas: swap.gas } : {}) }), true),
  };
}
