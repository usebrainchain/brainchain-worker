// `exit`: the worker's USDG on BrainChain paid back within a minute instead of the bridge's seven days. The desk pays
// it on Robinhood Chain, or, with `--to-solana`, as USDC on Solana through Relay: the transfer to the desk carries the
// Solana address after its arguments, so nothing else is signed and nothing is needed on Robinhood Chain.

import bs58 from "bs58";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, http, parseUnits, type Address, type Hex, type PrivateKeyAccount } from "viem";

import { RECEIPT_MS } from "./chain.js";
import { chainOf, parentChainOf, type Network } from "./network.js";

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
  solana?: string;
  relayRequest?: string;
}

/** A Solana address: 32 bytes in base58. */
export function isSolanaAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** A transfer to the desk with the Solana address after its arguments, which the desk reads to pay there. */
export function exitCalldata(desk: Address, amount: bigint, solana?: string): Hex {
  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [desk, amount] });
  return solana ? `${transfer}${Buffer.from(bs58.decode(solana)).toString("hex")}` : transfer;
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
  /** Sends the bounty token to the desk on BrainChain, naming a Solana address when given, and waits for it to be mined. */
  sendToDesk(token: Address, desk: Address, amount: bigint, solana?: string): Promise<Hex>;
}

export function createExitChain(network: Network, account: PrivateKeyAccount): ExitChain {
  const read = createPublicClient({ chain: chainOf(network), transport: http(network.rpc, { timeout: 20_000 }) });
  const wallet = createWalletClient({ account, chain: chainOf(network), transport: http(network.rpc, { timeout: 20_000 }) });
  return {
    account: account.address,
    bountyBalance: (token) => read.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    async sendToDesk(token, desk, amount, solana) {
      const hash = await wallet.sendTransaction({ to: token, data: exitCalldata(desk, amount, solana) });
      const receipt = await read.waitForTransactionReceipt({ hash, timeout: RECEIPT_MS });
      if (receipt.status !== "success") throw new Error(`the transfer to the desk reverted (${hash})`);
      return hash;
    },
  };
}

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

  if (options.toSolana !== undefined) log(`Paid as USDC on Solana to ${options.toSolana}, less Relay's own fee, unless the move would cost more than 3% (or 0.50 USD); then it is paid on the parent chain.`);
  if (dry) {
    log("Dry run, nothing sent.");
    return;
  }

  const tx = await chain.sendToDesk(terms.token, terms.desk, amount, options.toSolana);
  log(`Sent to the desk on ${network.name} (${tx}). Waiting for the payout, usually under a minute.`);
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
  if (record.solana && record.relayRequest) {
    log(`Paid on Solana: ${show(BigInt(record.net))} as USDC to ${record.solana} (Relay request ${record.relayRequest}).`);
    return;
  }
  log(`Paid on the parent chain: ${show(BigInt(record.net))} (${record.payoutTx})${record.reason ? `. ${record.reason}` : ""}.`);
}
