// `exit`: the worker's USDG on BrainChain back on Robinhood Chain within minutes instead of the bridge's seven days.
// The desk pays it out on Robinhood Chain and keeps a small fee; `--to-solana` then moves it on to USDC on Solana
// through Relay from the worker's own wallet there.

import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits, type Address, type Hex, type PrivateKeyAccount } from "viem";

import { RECEIPT_MS } from "./chain.js";
import { chainOf, parentChainOf, type Network } from "./network.js";
import { checkReturn, relayQuote, SOLANA_CHAIN_ID, SOLANA_USDC, waitForRelay, type EvmItem, type RelayQuote } from "./relay.js";

export interface ExitTerms {
  desk: Address;
  token: Address;
  payoutChainId: number;
  payoutToken: Address;
  feeBps: number;
  minFeeUnits: string;
  minUnits: string;
  maxUnits: string;
}

export interface ExitRecord {
  state: "waiting" | "paying" | "paid" | "returning" | "returned";
  net: string;
  fee: string;
  payoutTx?: Hex;
  returnTx?: Hex;
  reason?: string;
}

/** A Solana address: 32 to 44 base58 characters. */
export function isSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export function exitFee(amount: bigint, terms: Pick<ExitTerms, "feeBps" | "minFeeUnits">): bigint {
  const proportional = (amount * BigInt(terms.feeBps)) / 10_000n;
  const floor = BigInt(terms.minFeeUnits);
  const fee = proportional > floor ? proportional : floor;
  return fee > amount ? amount : fee;
}

export async function exitTerms(service: string, fetchImpl: typeof fetch = fetch): Promise<ExitTerms> {
  const response = await fetchImpl(`${service}/exits`, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) throw new Error("Fast exits are off on this network");
  if (!response.ok) throw new Error(`${service}/exits answered ${response.status}`);
  return (await response.json()) as ExitTerms;
}

export async function exitRecord(service: string, tx: Hex, fetchImpl: typeof fetch = fetch): Promise<ExitRecord | undefined> {
  const response = await fetchImpl(`${service}/exits/${tx}`, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${service}/exits answered ${response.status}`);
  return ((await response.json()) as { exits: ExitRecord[] }).exits[0];
}

/** What `exit` needs from the chains, so the flow can be tested without them. */
export interface ExitChain {
  account: Address;
  bountyBalance(token: Address): Promise<bigint>;
  /** Sends the bounty token to the desk on BrainChain and waits for it to be mined. */
  sendToDesk(token: Address, desk: Address, amount: bigint): Promise<Hex>;
  parentEth(): Promise<bigint>;
  /** Sends one of Relay's transactions on the payout chain and waits for it. */
  sendParent(item: EvmItem): Promise<Hex>;
}

export function createExitChain(network: Network, account: PrivateKeyAccount): ExitChain {
  const bridge = network.bridge;
  const l3 = { read: createPublicClient({ chain: chainOf(network), transport: http(network.rpc, { timeout: 20_000 }) }) };
  const l3Wallet = createWalletClient({ account, chain: chainOf(network), transport: http(network.rpc, { timeout: 20_000 }) });
  const parent = bridge ? createPublicClient({ chain: parentChainOf(bridge), transport: http(bridge.rpc, { timeout: 20_000 }) }) : undefined;
  const parentWallet = bridge ? createWalletClient({ account, chain: parentChainOf(bridge), transport: http(bridge.rpc, { timeout: 20_000 }) }) : undefined;
  return {
    account: account.address,
    bountyBalance: (token) => l3.read.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    async sendToDesk(token, desk, amount) {
      const hash = await l3Wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [desk, amount] });
      const receipt = await l3.read.waitForTransactionReceipt({ hash, timeout: RECEIPT_MS });
      if (receipt.status !== "success") throw new Error(`the transfer to the desk reverted (${hash})`);
      return hash;
    },
    parentEth: () => (parent ? parent.getBalance({ address: account.address }) : Promise.resolve(0n)),
    async sendParent(item) {
      if (!parent || !parentWallet) throw new Error(`${network.name} has no parent chain`);
      const hash = await parentWallet.sendTransaction({ to: item.to, data: item.data, value: BigInt(item.value ?? "0") });
      const receipt = await parent.waitForTransactionReceipt({ hash, timeout: RECEIPT_MS });
      if (receipt.status !== "success") throw new Error(`Relay's transaction ${hash} reverted`);
      return hash;
    },
  };
}

/** Gas the two Relay transactions on Robinhood Chain need, with room to spare. */
export const RELAY_GAS_WEI = 20_000_000_000_000n;

export async function exit(
  network: Network,
  chain: ExitChain,
  options: {
    amount?: string;
    toSolana?: string;
    dry: boolean;
    log: (line: string) => void;
    fetchImpl?: typeof fetch;
    pollMs?: number;
    waitMs?: number;
    quote?: typeof relayQuote;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const { log, dry } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if (options.toSolana !== undefined) {
    if (!isSolanaAddress(options.toSolana)) throw new Error(`"${options.toSolana}" is not a Solana address`);
    if (network.id !== "mainnet") throw new Error("--to-solana is mainnet only: Relay connects Solana with Robinhood Chain mainnet, not the testnets");
  }
  const terms = await exitTerms(network.service, fetchImpl);
  const balance = await chain.bountyBalance(terms.token);
  const amount = options.amount === undefined ? balance : parseUnits(options.amount, 6);
  const min = BigInt(terms.minUnits);
  const max = BigInt(terms.maxUnits);
  const symbol = network.bountySymbol;
  const show = (v: bigint) => `${formatUnits(v, 6)} ${symbol}`;
  if (amount === 0n) throw new Error(`The wallet holds no ${symbol} on ${network.name}`);
  if (amount > balance) throw new Error(`The wallet holds ${show(balance)} on ${network.name}, less than ${show(amount)}`);
  if (amount < min) throw new Error(`An exit is at least ${show(min)}`);
  if (amount > max) throw new Error(`An exit is at most ${show(max)}; send the rest in another exit`);
  const fee = exitFee(amount, terms);
  const net = amount - fee;
  log(`Exit ${show(amount)} from ${network.name}: ${show(net)} arrives on the parent chain (chain ${terms.payoutChainId}) after a ${show(fee)} fee.`);

  if (options.toSolana !== undefined) {
    const eth = await chain.parentEth();
    if (eth < RELAY_GAS_WEI) {
      throw new Error(`Moving it on to Solana needs about 0.00002 ETH on ${network.bridge?.name ?? "the parent chain"} for gas; the wallet holds ${formatUnits(eth, 18)}. \`fund --from-solana\` brings some.`);
    }
  }
  const solanaQuote = (net: bigint) =>
    (options.quote ?? relayQuote)(
      { user: chain.account, recipient: options.toSolana!, originChainId: terms.payoutChainId, destinationChainId: SOLANA_CHAIN_ID, originCurrency: terms.payoutToken, destinationCurrency: SOLANA_USDC, amount: net },
      fetchImpl,
    );
  // Priced before anything leaves BrainChain, so a refused Solana leg never strands the exit halfway.
  if (options.toSolana !== undefined) {
    const preview = await solanaQuote(net);
    checkReturn(preview);
    log(`Relay quotes ${preview.outFormatted} USDC on Solana for it.`);
  }
  if (dry) {
    log("Dry run, nothing sent.");
    return;
  }

  const tx = await chain.sendToDesk(terms.token, terms.desk, amount);
  log(`Sent to the desk on ${network.name} (${tx}). Waiting for the payout; the desk picks it up within a round, usually a few minutes.`);
  const end = Date.now() + (options.waitMs ?? 1_800_000);
  let last = "";
  let record: ExitRecord | undefined;
  for (;;) {
    record = await exitRecord(network.service, tx, fetchImpl).catch(() => undefined);
    if (record?.state === "paid" || record?.state === "returned") break;
    if (record?.reason && record.reason !== last) log(`Waiting: ${record.reason}.`);
    last = record?.reason ?? last;
    if (Date.now() > end) {
      log(`Still waiting after ${Math.round((options.waitMs ?? 1_800_000) / 60_000)} minutes. The desk pays it or sends it back within a day; follow it at ${network.service}/exits/${tx}.`);
      return;
    }
    await sleep(options.pollMs ?? 10_000);
  }
  if (record.state === "returned") {
    log(`The desk sent it back on ${network.name}: ${record.reason ?? "no reason given"} (${record.returnTx}).`);
    process.exitCode = 1;
    return;
  }
  log(`Paid on the parent chain: ${show(BigInt(record.net))} (${record.payoutTx}).`);
  if (options.toSolana === undefined) return;

  const quote = await solanaQuote(BigInt(record.net));
  checkReturn(quote);
  await sendEvmSteps(quote, chain);
  log(`Moving ${show(BigInt(record.net))} to Solana: ${quote.outFormatted} USDC to ${options.toSolana}.`);
  const status = await waitForRelay(quote.requestId, 600_000, fetchImpl);
  if (status === "success") log(`Arrived on Solana. Relay request ${quote.requestId}.`);
  else {
    log(`Relay reports "${status}" for request ${quote.requestId}. A refund comes back to the wallet on the parent chain.`);
    process.exitCode = 1;
  }
}

async function sendEvmSteps(quote: RelayQuote, chain: Pick<ExitChain, "sendParent">): Promise<void> {
  for (const step of quote.steps) {
    for (const item of step.items) await chain.sendParent(item.data as EvmItem);
  }
}
