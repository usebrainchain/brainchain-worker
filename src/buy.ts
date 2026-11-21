// `buy-stake`: a worker that holds ETH or USDG on Robinhood Chain buys at least the BRAIN join still needs, through 0x.
// It buys 0x's price for that BRAIN, then an exact-in quote that sells a little more than the price says, so the spend
// is known before anything is signed and the least the swap may bring still covers the need. Each costs 0.01 USDC on
// Base, so everything that can stop the buy without them is checked before they are paid for. Nothing is signed on
// Robinhood Chain until 0x's signature on the quote verifies, its calldata does only this swap for this wallet, spends
// no more than this command accepts and brings at least the BRAIN needed, and a simulation shows it doing so.

import { ALLOWANCE_HOLDER, NATIVE, readSettlers, signedRequestOf, verifyQuote, verifyResponse, type Quote, type Settlers } from "brainchain-verify/zerox";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

import { DepositSent } from "./bridge.js";
import { reason, RECEIPT_MS } from "./chain.js";
import { cli } from "./invoked.js";
import { parentChainOf, rpcTransport, type Network } from "./network.js";
import { NATIVE as RELAY_NATIVE } from "./relay.js";
import { PARENT_ETH_KEEP } from "./solana.js";
import { PROBE_CODE, probeAbi } from "./probe.js";
import { grouped } from "./standing.js";
import { printable } from "./work.js";
import { NotPaid, type PaidQuote } from "./zerox.js";

export type Pay = "eth" | "usdg";

/**
 * The most the sale may spend, as a share over the worth at Relay's price of
 * the BRAIN join needs. It spends exactly 0x's estimate for that BRAIN, which
 * has run 3.6% to 4.5% over its worth, plus the room below.
 */
export const MAX_OVER_WORTH = 0.07;
/**
 * Per mille added to 0x's estimate of the sale the BRAIN needs, so that the
 * least the sale may bring, the quote less its slippage, still covers it.
 */
const ROOM_PER_MILLE = 15n;
/** 0x's default, asked for by name so the room above holds if the default moves. */
export const SLIPPAGE_BPS = 100;
/** Gas for an approval, which a USDG sale needs once. */
const APPROVE_GAS = 60_000n;
/** Gas a swap is budgeted before its quote names its own; quotes have named 0.66 to 1.16 million. */
const SWAP_GAS = 1_500_000n;
/** 0x's signature is held to 60 seconds by this machine's clock, so a clock further than this from the chain's is refused. */
const CLOCK_SEC = 30;
/** ETH the simulation lends a wallet that lacks it, so a dry run still shows what the swap does. */
const LENT = parseEther("10");
/** Settler's error once a quote's deadline, about 300 seconds after 0x made it, has passed. */
const EXPIRED = toFunctionSelector("SignatureExpired(uint256)");

export interface Swap {
  to: Address;
  data: Hex;
  value: bigint;
  gas?: bigint;
}

/** A swap that was sent and not confirmed: it can still land, so another run could buy twice. */
export class SwapSent extends Error {}

/** A swap that was mined and reverted, so nothing was bought. */
export class SwapReverted extends Error {
  constructor(readonly hash: Hex) {
    super(`transaction ${hash} reverted`);
  }
}

/** What buy-stake reads and sends on the parent chain, and reads on the payment chain. */
export interface BuyChain {
  account: Address;
  eth(): Promise<bigint>;
  balance(token: Address): Promise<bigint>;
  allowance(token: Address, spender: Address): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  /** The code at the wallet's address, which a plain key has none of. */
  code(): Promise<Hex | undefined>;
  /** The latest block's time, in seconds. */
  blockTime(): Promise<bigint>;
  /** The worker's USDC where it pays for quotes. */
  paymentBalance(): Promise<bigint>;
  settlers(): Promise<Settlers>;
  /** Runs the swap on the latest block, after the approval when given, and sends nothing: what it takes and what it brings. */
  simulate(swap: Swap, sold: Address, bought: Address, options?: { approve?: bigint; lend?: bigint }): Promise<{ spent: bigint; gained: bigint }>;
  approve(token: Address, spender: Address, amount: bigint): Promise<Hex>;
  /** Sends the swap and waits for it; `sent` hears its hash before it is mined. Throws SwapReverted or SwapSent. */
  send(swap: Swap, sent?: (hash: Hex) => void): Promise<Hex>;
}

export interface BuyDeps {
  chain: BuyChain;
  /** What join needs on BrainChain, and what the wallet holds there. */
  needs(): Promise<{ need: bigint; held: bigint }>;
  stakeProblem(): Promise<string | undefined>;
  /** What this wallet has sent that could make another buy a second one, or undefined. */
  inFlight(): Promise<string | undefined>;
  /** A token's price in USD, by its address as Relay names it. */
  price(token: string): Promise<number>;
  /** Buys 0x's price or quote for this query. */
  quote(query: Record<string, string>, kind: "price" | "quote"): Promise<PaidQuote>;
  /** Hears the swap's hash once it is sent. */
  swapSent?(hash: Hex): void;
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
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const yes = (answer: string) => ["y", "yes"].includes(answer.trim().toLowerCase());
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

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
  const eth = options.pay === "eth";
  const sell = eth ? { token: NATIVE, relay: RELAY_NATIVE, symbol: "ETH", decimals: 18 } : { token: usdgToken, relay: usdgToken, symbol: network.bountySymbol, decimals: 6 };
  const sells = (amount: bigint, up = false) => `${figure(amount, sell.decimals, up)} ${sell.symbol}`;
  const brains = (amount: bigint) => `${grouped(amount, 18)} ${network.stakeSymbol}`;
  // What a sale brings is rarely a whole number of BRAIN, so figures drop the fraction, and one still to buy rounds up.
  const whole = (amount: bigint) => brains(amount - (amount % 10n ** 18n));
  const wholeUp = (amount: bigint) => whole(amount + 10n ** 18n - 1n);
  const usdc = (amount: bigint) => `${formatUnits(amount, 6)} USDC`;
  const each = zerox.payment.price;
  const now = deps.now ?? Date.now;
  const unpaid = (message: string) => new Error(`${message.replace(/\.?$/, ".")} Nothing was paid.`);

  const pinned = await deps.stakeProblem();
  if (pinned) throw unpaid(pinned);
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
  const holds = `${whole(held)} on ${network.name}${onParent > 0n ? ` and ${whole(onParent)} on ${parent.name}` : ""}`;
  log(`join needs ${brains(need)} on ${network.name}. ${chain.account} holds ${holds}, so this buys at least ${wholeUp(amount)} with ${sell.symbol} on ${parent.name}, through 0x.`);

  const [busy, code, blockTime] = await Promise.all([deps.inFlight(), chain.code(), chain.blockTime()]);
  if (busy) throw unpaid(busy);
  if (code !== undefined && code !== "0x") {
    throw unpaid(`buy-stake needs a plain key: ${chain.account} has code on ${parent.name}, an EIP-7702 delegation or a contract wallet, and the swap is checked as if it had none`);
  }
  const drift = Math.round(now() / 1000) - Number(blockTime);
  if (Math.abs(drift) > CLOCK_SEC) {
    throw unpaid(`This machine's clock is ${Math.abs(drift)} seconds ${drift > 0 ? "ahead of" : "behind"} ${parent.name}'s latest block, and 0x's quote is checked against it. Set the clock right and run again`);
  }

  const paidWith = await chain.paymentBalance().catch((error: unknown) => {
    throw unpaid(`Could not read the wallet's USDC on ${zerox.payment.name} (${reason(error).replace(/\.$/, "")})`);
  });
  if (paidWith < 2n * each) {
    throw unpaid(
      `buy-stake pays 0x ${usdc(each)} on ${zerox.payment.name} for a price and ${usdc(each)} for a quote, from the worker's own key, and ${chain.account} holds ${formatUnits(paidWith, 6)} USDC there. ` +
        `Send that address at least ${usdc(2n * each)} on ${zerox.payment.name}`,
    );
  }
  let sellUsd: number;
  let brainUsd: number;
  try {
    [sellUsd, brainUsd] = await Promise.all([deps.price(sell.relay), deps.price(brain)]);
  } catch (error) {
    throw unpaid(`Could not read prices from Relay, which the spend is measured against (${reason(error).replace(/\.$/, "")})`);
  }
  const worth = Number(formatUnits(amount, 18)) * brainUsd;
  const ceiling = BigInt(Math.floor(((worth * (1 + MAX_OVER_WORTH)) / sellUsd) * 10 ** sell.decimals));
  const cap = `${Math.round(MAX_OVER_WORTH * 100)}%`;
  const inUsd = (spent: bigint) => Number(formatUnits(spent, sell.decimals)) * sellUsd;
  const cost = (spent: bigint) => `${sells(spent, true)} (${usd(inUsd(spent))} USD, ${percent(inUsd(spent) / worth - 1)} over what ${brains(amount)} is worth)`;

  const holder = ALLOWANCE_HOLDER[parent.chainId]!;
  let settlers: Settlers;
  try {
    settlers = await chain.settlers();
  } catch (error) {
    throw unpaid(`Could not read 0x's Settler registry on ${parent.name} (${reason(error).replace(/\.$/, "")})`);
  }
  if (!settlers.current) throw unpaid(`0x's registry on ${parent.name} says its Settler is paused, so no quote could be sent now. Try again later`);
  const [ethHeld, token, gasPrice, allowance] = await Promise.all([
    chain.eth(),
    eth ? undefined : chain.balance(sell.token),
    chain.gasPrice(),
    eth ? undefined : chain.allowance(sell.token, holder),
  ]);
  const balance = token ?? ethHeld;
  const lacks = (most: bigint, gas: bigint) => {
    const keep = (eth ? most : 0n) + gas + PARENT_ETH_KEEP;
    return [
      ...(!eth && balance < most ? [`${chain.account} holds ${sells(balance)} on ${parent.name}, and the sale may take up to ${sells(most, true)}.`] : []),
      ...(ethHeld < keep
        ? [
            `${chain.account} holds ${figure(ethHeld, 18)} ETH on ${parent.name}, and needs about ${figure(keep, 18, true)} ETH: ` +
              `${eth ? `up to ${sells(most, true)} for the sale, ` : ""}${figure(gas, 18, true)} ETH for gas and ${formatUnits(PARENT_ETH_KEEP, 18)} ETH kept for the bridge's deposit.`,
          ]
        : []),
    ];
  };
  const gasFor = (swapGas: bigint, approves: boolean) => (swapGas + (approves ? APPROVE_GAS : 0n)) * gasPrice;
  const approvesFor = (spend: bigint) => allowance !== undefined && allowance < spend;
  const shortfall = lacks(ceiling, gasFor(SWAP_GAS, approvesFor(ceiling)));
  if (!options.dry && shortfall.length > 0) throw new Error(`${shortfall.join("\n")}\nNothing was paid.`);

  log(
    options.dry
      ? `Dry run: buys a price and a quote from 0x, ${usdc(each)} each on ${zerox.payment.name}, and sends nothing else.`
      : `Buying a price and a quote from 0x, ${usdc(each)} each on ${zerox.payment.name}...`,
  );
  let paid = 0n;
  const spentLine = () => `The ${usdc(paid)} paid to 0x is spent`;
  const query = { chainId: String(parent.chainId), sellToken: sell.token, buyToken: brain, taker: chain.account };
  const priced = await deps.quote({ ...query, buyAmount: amount.toString() }, "price");
  paid += each;
  if (priced.payment) log(`Paid 0x ${usdc(each)} on ${zerox.payment.name} for a price: ${priced.payment}`);
  const estimate = estimateOf(priced, { sellToken: sell.token, buyToken: brain, buyAmount: amount }, now);
  if (typeof estimate === "string") throw new Error(`0x's price could not be used: ${estimate.replace(/\.?$/, ".")} ${spentLine()}; nothing else was sent.`);
  const sellAmount = (estimate * (1000n + ROOM_PER_MILLE) + 999n) / 1000n;
  if (sellAmount > ceiling) {
    throw new Error(
      `0x prices ${brains(amount)} at ${sells(estimate, true)}, so a sale that brings at least that many spends ${cost(sellAmount)}, more than the ${cap} buy-stake accepts, ${sells(ceiling)}. ` +
        `Try again later, or buy at ripples.run and use ${cli("bridge --stake")}. ${spentLine()}; nothing else was sent.`,
    );
  }

  let bought: PaidQuote;
  try {
    bought = await deps.quote({ ...query, sellAmount: sellAmount.toString(), slippageBps: String(SLIPPAGE_BPS) }, "quote");
  } catch (error) {
    if (error instanceof NotPaid) throw new Error(`${error.message.replace(/ Nothing was paid\.$/, "")} Nothing was paid for the quote; the price's ${usdc(each)} is spent.`);
    throw new Error(`${reason(error).replace(/\.?$/, ".")} The price bought before it cost ${usdc(each)}.`);
  }
  paid += each;
  if (bought.payment) log(`Paid 0x ${usdc(each)} on ${zerox.payment.name} for a quote: ${bought.payment}`);
  const intent = { chainId: parent.chainId, taker: chain.account, sellToken: sell.token, buyToken: brain, sellAmount, minBuyAmount: amount, slippageBps: SLIPPAGE_BPS };
  const report = await verifyQuote(bought.response, bought.url, intent, { settlers: () => chain.settlers(), now });
  const failed = report.checks.find((c) => c.status === "fail");
  if (failed || !report.quote || !report.decoded) {
    const promised = report.decoded?.minAmountOut;
    const why =
      failed?.name === "zerox-key"
        ? unknownKey(report.signature.keyid)
        : failed?.name === "quote-min-out" && promised !== undefined && promised < amount
          ? `for ${sells(sellAmount, true)} it promises only ${whole(promised)}, under the ${brains(amount)} join needs, so the price moved after 0x gave it. Try again`
          : (failed?.message ?? "it could not be read");
    throw new Error(`0x's quote was refused before anything was signed: ${why.replace(/\.?$/, ".")} ${spentLine()}; nothing else was sent.`);
  }
  const quote: Quote = report.quote;
  const floor = report.decoded.minAmountOut;
  const swap: Swap = { to: quote.transaction.to, data: quote.transaction.data, value: quote.transaction.value, ...(quote.transaction.gas ? { gas: quote.transaction.gas } : {}) };
  const approves = approvesFor(sellAmount);
  const how = { approves, most: sellAmount, wants: amount, eth, rerun: usdc(2n * each) };

  const simulated = await simulateBuy(chain, swap, sell.token, brain, { ...how, covered: balance >= sellAmount });
  if (typeof simulated === "string") throw new Error(`${simulated}. ${spentLine()}; nothing else was sent.`);
  const expected = simulated?.gained ?? quote.buyAmount;
  const extra = expected > amount ? expected - amount : 0n;
  const perBrain = inUsd(sellAmount) / (Number(formatUnits(expected, 18)) * brainUsd) - 1;
  const gas = gasFor(swap.gas ?? SWAP_GAS, approves);
  const fee = feeOf(bought.response.body, sell.token);
  const signedAgo = report.signature.created === undefined ? "" : `, signed ${Math.max(0, Math.round(now() / 1000) - report.signature.created)} seconds ago`;
  log(
    [
      `0x quotes ${whole(quote.buyAmount)} for exactly ${cost(sellAmount)}. The sale spends that and no more, so it is also the worst case; the swap reverts below ${whole(floor)}, and join needs ${brains(amount)}.`,
      `  For the ${whole(expected)} expected${simulated ? " in the simulation" : ""}, that is ${percent(perBrain)} over Relay's price for each; the ${whole(extra)} beyond what join needs stay in the wallet on ${parent.name}.`,
      `  At Relay's price of ${brainUsd.toPrecision(3)} USD, ${brains(amount)} is worth ${usd(worth)} USD, and buy-stake spends at most ${cap} over that, ${sells(ceiling)}.` +
        (fee === undefined ? "" : ` 0x's fee of ${sells(fee, true)} is included.`),
      `  Checked: 0x's signature (key ${report.signature.keyid}${signedAgo}); the transaction calls 0x's AllowanceHolder ${short(holder)}, which lets Settler ${short(report.decoded.settler)}, the one 0x's registry names, take exactly ${sells(sellAmount, true)}; it pays the BRAIN to ${short(chain.account)} and reverts below ${whole(floor)}.`,
      simulated
        ? `  Simulated on ${parent.name}${simulated.lent ? `, as if the wallet held the ${sell.symbol}` : ""}: it takes ${sells(simulated.spent)} and brings ${whole(simulated.gained)}.`
        : `  Not simulated: the wallet holds ${sells(balance)} of the ${sells(sellAmount, true)} the sale takes.`,
      `  Gas on ${parent.name}: about ${figure(gas, 18, true)} ETH for ${approves ? `an approval of ${sells(sellAmount, true)} to AllowanceHolder and the swap` : "the swap"}.`,
    ].join("\n"),
  );
  if (options.dry) {
    // Held to the most a real run holds the wallet to before it pays, so the two agree.
    const lacking = lacks(ceiling, gasFor(swap.gas ?? SWAP_GAS, approvesFor(ceiling)));
    const done = `Dry run: ${usdc(paid)} paid for a price and a quote, nothing else sent.`;
    if (lacking.length > 0) throw new Error([...lacking, done].join("\n"));
    return log(done);
  }
  const lacking = lacks(sellAmount, gas);
  if (lacking.length > 0) throw new Error(`${lacking.join("\n")}\n${spentLine()}; nothing else was sent.`);
  if (!options.yes) {
    const question = `Buy about ${whole(expected)}, at least ${whole(floor)}, for exactly ${cost(sellAmount)}? [y/N] `;
    if (!yes(await options.ask!(question))) return log(`Nothing sent. ${spentLine()}.`);
  }

  // Again on the latest block, before the approval: a quote that expired or a price that moved while the person
  // answered then costs nothing more.
  const again = await simulateBuy(chain, swap, sell.token, brain, { ...how, covered: true });
  if (typeof again === "string" || again === undefined) throw new Error(`${again ?? "The swap could not be simulated"}. Nothing was sent. ${spentLine()}.`);
  if (approves) {
    log(`Approving ${sells(sellAmount, true)} for 0x's AllowanceHolder...`);
    try {
      await chain.approve(sell.token, holder, sellAmount);
    } catch (error) {
      throw new Error(`The approval did not go through (${reason(error).replace(/\.$/, "")}). Nothing was bought. ${spentLine()}.`);
    }
  }
  const left = approves ? ` The approval of ${sells(sellAmount, true)} to AllowanceHolder stays, and only this wallet's own transactions can use it.` : "";
  log(`Buying at least ${brains(amount)}...`);
  const before = await chain.balance(brain);
  let tx: Hex;
  try {
    tx = await chain.send(swap, deps.swapSent);
  } catch (error) {
    if (error instanceof SwapSent) throw error;
    if (error instanceof SwapReverted) throw new Error(`The swap reverted on ${parent.name} (${error.hash}), so nothing was bought.${left}`);
    throw new Error(`The swap could not be sent (${reason(error).replace(/\.$/, "")}), so nothing was bought.${left}`);
  }
  const after = await chain.balance(brain);
  const got = after > before ? after - before : 0n;
  log(`Bought ${whole(got)} on ${parent.name}: ${tx}${got > amount ? `. The ${whole(got - amount)} beyond what join needs stay in the wallet there.` : ""}`);

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

const unknownKey = (keyid: string | undefined) => `0x signed it with key ${keyid}, which this release does not carry. Update with npx brainchain-worker@latest`;

/**
 * 0x's estimate of the sale that brings `buyAmount`, from a signed exact-out
 * price, or why it cannot be used. It only sizes the quote bought next, which
 * is then checked in full.
 */
function estimateOf(paid: PaidQuote, wants: { sellToken: Address; buyToken: Address; buyAmount: bigint }, now: () => number): bigint | string {
  const signature = verifyResponse(paid.response, signedRequestOf(paid.url), { now });
  const failed = signature.checks.find((c) => c.status === "fail");
  if (failed) return failed.name === "zerox-key" ? unknownKey(signature.keyid) : failed.message;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(paid.response.body).toString("utf8")) as Record<string, unknown>;
  } catch {
    return "the body 0x signed is not JSON";
  }
  if (paid.response.status !== 200) {
    const said = [body.name, body.message].filter((part): part is string => typeof part === "string").map((part) => printable(part).slice(0, 200));
    return `0x answered ${paid.response.status}${said.length > 0 ? ` ${said.join(": ")}` : ""}`;
  }
  if (body.liquidityAvailable === false) return "0x has no route for this trade right now";
  const net = body.estimatedNetSellAmount;
  const fits =
    body.mode === "exact-out" &&
    typeof body.sellToken === "string" &&
    same(body.sellToken, wants.sellToken) &&
    typeof body.buyToken === "string" &&
    same(body.buyToken, wants.buyToken) &&
    body.buyAmount === wants.buyAmount.toString() &&
    typeof net === "string" &&
    /^[1-9]\d{0,77}$/.test(net);
  return fits ? BigInt(net as string) : "it is not an exact-out price for this trade";
}

/** 0x's own fee in the token sold, as the signed body states it. */
function feeOf(body: Uint8Array, sold: Address): bigint | undefined {
  try {
    const fee = (JSON.parse(Buffer.from(body).toString("utf8")) as { fees?: { zeroExFee?: { amount?: unknown; token?: unknown } | null } }).fees?.zeroExFee;
    return typeof fee?.amount === "string" && /^\d+$/.test(fee.amount) && typeof fee.token === "string" && same(fee.token, sold) ? BigInt(fee.amount) : undefined;
  } catch {
    return undefined;
  }
}

const expired = (error: unknown) =>
  error instanceof BaseError &&
  error.walk((e) => {
    const data = (e as { data?: unknown }).data;
    return typeof data === "string" && data.startsWith(EXPIRED);
  }) !== null;

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
  how: { approves: boolean; most: bigint; wants: bigint; covered: boolean; eth: boolean; rerun: string },
): Promise<{ spent: bigint; gained: bigint; lent: boolean } | string | undefined> {
  if (!how.covered && !how.eth) return undefined;
  const lend = !how.covered ? swap.value + LENT : undefined;
  try {
    const result = await chain.simulate(swap, sold, bought, { ...(how.approves ? { approve: how.most } : {}), ...(lend ? { lend } : {}) });
    if (result.spent > how.most) return `The swap takes ${result.spent} when simulated, more than the ${how.most} its calldata allows`;
    if (result.gained < how.wants) return `The swap brings ${result.gained} when simulated, less than the ${how.wants} asked for`;
    return { ...result, lent: lend !== undefined };
  } catch (error) {
    if (expired(error)) return `The quote expired before it was sent: run buy-stake again (a new price and quote cost ${how.rerun})`;
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
      throw new SwapSent(
        `The swap was sent on ${bridge.name} (${hash}) and could not be confirmed (${reason(error).replace(/\.$/, "")}). It can still land, so check it before running buy-stake again: another run buys more.`,
      );
    });
    if (receipt.status !== "success") throw swap ? new SwapReverted(hash) : new Error(`transaction ${hash} reverted on ${bridge.name}`);
    return hash;
  };
  return {
    account: self,
    eth: () => read.getBalance({ address: self }),
    balance: (token) => read.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [self] }),
    allowance: (token, spender) => read.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [self, spender] }),
    gasPrice: () => read.getGasPrice(),
    code: () => read.getCode({ address: self }),
    blockTime: async () => (await read.getBlock()).timestamp,
    paymentBalance: () => payment.readContract({ address: zerox.payment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [self] }),
    settlers: () => readSettlers(read, bridge.chainId),
    async simulate(swap, sold, gotten, options = {}) {
      const { data } = await read.call({
        // From the wallet, as the swap is sent, and within the swap's own gas, so a route that runs short fails here.
        // The probe's own few thousand gas make this a little stricter than the transaction.
        account: self,
        to: self,
        ...(swap.gas ? { gas: swap.gas + (options.approve ? APPROVE_GAS : 0n) } : {}),
        data: encodeFunctionData({ abi: probeAbi, functionName: "probe", args: [sold, gotten, options.approve ?? 0n, swap.to, swap.value, swap.data] }),
        stateOverride: [{ address: self, code: PROBE_CODE, ...(options.lend === undefined ? {} : { balance: options.lend }) }],
      });
      const [spent, gained] = decodeFunctionResult({ abi: probeAbi, functionName: "probe", data: data ?? "0x" });
      return { spent, gained };
    },
    approve: async (token, spender, amount) => wait(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] })),
    async send(swap, sent) {
      const hash = await wallet.sendTransaction({ to: swap.to, data: swap.data, value: swap.value, ...(swap.gas ? { gas: swap.gas } : {}) });
      sent?.(hash);
      return wait(hash, true);
    },
  };
}
