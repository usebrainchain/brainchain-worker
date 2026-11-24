// `fund`: an agent funds its BrainChain worker from the chain its money lives on, Solana or Base. Relay turns its USDC
// there into ETH (and, with --stake, BRAIN) for the worker's wallet on Robinhood Chain in seconds; `bridge` then moves
// on to BrainChain what this run brought. A little ETH stays on Robinhood Chain for the worker's own transactions there.

import { formatEther, formatUnits, parseUnits, type Address } from "viem";

import { DepositSent } from "./bridge.js";
import { reason } from "./chain.js";
import { cli } from "./invoked.js";
import { NATIVE, type RelayQuote } from "./relay.js";

/** USDC turned into ETH for gas, unless --gas-usdc says otherwise. */
export const DEFAULT_GAS_USDC = "2";
/** ETH left on Robinhood Chain when the rest goes to BrainChain: enough for a token deposit and a few transactions there. */
export const PARENT_ETH_KEEP = 300_000_000_000_000n;
/** How often a balance is read after Relay reports a move settled, and how far apart: the chain's RPC can lag Relay's word. */
const ARRIVAL_READS = 10;
const ARRIVAL_WAIT_MS = 3_000;

/** Where the USDC comes from: a wallet on Solana or on Base, and how Relay's moves out of it are checked and signed. */
export interface Funding {
  /** The chain the USDC is on, as the command's lines name it. */
  chain: string;
  owner: string;
  usdcBalance(): Promise<bigint>;
  /** What the wallet lacks for its own chain's fees, said beside a shortfall; undefined when it lacks nothing. */
  feeShortfall(): Promise<string | undefined>;
  /** Quotes the move and checks its price and what it asks to sign, without sending anything. */
  preview(currency: string, amount: bigint, recipient: Address): Promise<RelayQuote>;
  /** Signs a checked quote, sends it, waits for Relay to fill it, and returns what to follow it by, such as "Solana <signature>". */
  send(quote: RelayQuote): Promise<string>;
}

/** How a USDC amount splits between gas and stake. Without --stake, what gas does not take stays where it is. */
export function split(usdc: bigint, gasUsdc: bigint, stake: boolean): { gas: bigint; stake: bigint } {
  if (!stake) return { gas: usdc < gasUsdc ? usdc : gasUsdc, stake: 0n };
  if (usdc <= gasUsdc) throw new Error(`With --stake the amount must be more than the ${formatUnits(gasUsdc, 6)} USDC kept for gas`);
  return { gas: gasUsdc, stake: usdc - gasUsdc };
}

/** What a move added to a balance, no more than was quoted, so a deposit from elsewhere stays out of it. */
export async function arrival(read: () => Promise<bigint>, before: bigint, quoted: bigint, sleep: (ms: number) => Promise<void>): Promise<{ held: bigint; brought: bigint }> {
  let held = await read();
  for (let tries = 1; held <= before && tries < ARRIVAL_READS; tries++) {
    await sleep(ARRIVAL_WAIT_MS);
    held = await read();
  }
  const rise = held > before ? held - before : 0n;
  return { held, brought: rise < quoted ? rise : quoted };
}

export interface FundOptions {
  funding: Funding;
  worker: Address;
  usdc: string;
  gasUsdc?: string;
  stake: boolean;
  stakeToken?: Address;
  /** What is wrong with the stake token, checked on chain before it is quoted; see bridge's stakeProblem. */
  stakeProblem?: () => Promise<string | undefined>;
  dry: boolean;
  log: (line: string) => void;
  /** The worker's balances on the parent chain, read before and after the moves. */
  parentEth: () => Promise<bigint>;
  parentStake: () => Promise<bigint>;
  /** Moves an amount from the parent chain to BrainChain once it has landed; `bridge` in the CLI. */
  bridgeOn: (asset: "eth" | "stake", amount: bigint) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export async function fund(options: FundOptions): Promise<void> {
  const { funding, log } = options;
  const where = funding.chain;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const usdc = parseUnits(options.usdc, 6);
  const gasUsdc = parseUnits(options.gasUsdc ?? DEFAULT_GAS_USDC, 6);
  const parts = split(usdc, gasUsdc, options.stake);
  if (options.stake && !options.stakeToken) throw new Error("This network's stake token is not on the parent chain");
  const pinned = options.stake ? await options.stakeProblem?.() : undefined;
  if (pinned) throw new Error(`${pinned}. Nothing was sent.`);
  const spends = parts.gas + parts.stake;
  const [held, fees] = await Promise.all([funding.usdcBalance(), funding.feeShortfall()]);
  const usdcs = (amount: bigint) => `${formatUnits(amount, 6)} USDC`;
  // Said after the quote, so a wallet not yet funded still learns what its USDC would bring.
  const short = [
    ...(held >= spends
      ? []
      : parts.stake > 0n
        ? [`The ${where} wallet ${funding.owner} holds ${usdcs(held)} of the ${usdcs(spends)} this run spends: ${usdcs(parts.gas)} for gas and ${usdcs(parts.stake)} for the stake token.`]
        : [`The ${where} wallet ${funding.owner} holds ${usdcs(held)}. Without --stake this run spends only the ${usdcs(parts.gas)} it turns into ETH for gas, and the wallet holds less than that.`]),
    ...(fees ? [fees] : []),
  ];
  const stays = usdc > spends ? ` The other ${usdcs(usdc - spends)} stays on ${where}.` : "";
  log(`From ${funding.owner} on ${where}: ${usdcs(parts.gas)} to ETH for gas${parts.stake ? ` and ${usdcs(parts.stake)} to the stake token` : ""}, for ${options.worker}.${stays}`);
  // Both legs are priced and checked before either moves, and those same quotes are signed, so a refused leg never leaves the other spent alone.
  let gasQuote: RelayQuote;
  let stakeQuote: RelayQuote | undefined;
  try {
    gasQuote = await funding.preview(NATIVE, parts.gas, options.worker);
    stakeQuote = parts.stake ? await funding.preview(options.stakeToken!, parts.stake, options.worker) : undefined;
  } catch (error) {
    if (short.length === 0) throw error;
    throw new Error([reason(error), ...short].join("\n"));
  }
  log(`Relay quotes ${gasQuote.outFormatted} ETH${stakeQuote ? ` and ${stakeQuote.outFormatted} of the stake token` : ""}.`);
  if (short.length > 0) throw new Error(`${short.join("\n")}${options.dry ? "\nDry run, nothing sent." : " Nothing was sent."}`);
  if (options.dry) {
    log("Dry run, nothing sent.");
    return;
  }
  // Read before anything moves: only what this run adds goes on to BrainChain, never what the wallet already held.
  const readStake = () => (stakeQuote ? options.parentStake() : Promise.resolve(0n));
  const [ethBefore, stakeBefore] = await Promise.all([options.parentEth(), readStake()]).catch((error: unknown) => {
    throw new Error(`Could not read the worker's balances on Robinhood Chain, so what this run brings could not be told from what it holds: ${reason(error).replace(/\.$/, "")}. Nothing was sent.`);
  });

  const onParent = new Map<"eth" | "stake", string>();
  const bridgeOn = async (asset: "eth" | "stake", amount: bigint) => {
    try {
      await options.bridgeOn(asset, amount);
    } catch (error) {
      // A deposit that was sent can still land, so what it carries is not left on the parent chain to bridge again.
      if (error instanceof DepositSent) onParent.delete(asset);
      throw error;
    }
    onParent.delete(asset);
  };
  try {
    const gas = await funding.send(gasQuote);
    onParent.set("eth", `${gasQuote.outFormatted} ETH`);
    log(`ETH arrived on Robinhood Chain: ${gasQuote.outFormatted} ETH (${gas}).`);
    if (stakeQuote) {
      const stake = await funding.send(stakeQuote);
      onParent.set("stake", `${stakeQuote.outFormatted} of the stake token`);
      log(`Stake token arrived on Robinhood Chain: ${stakeQuote.outFormatted} (${stake}).`);
    }
    const eth = await arrival(options.parentEth, ethBefore, gasQuote.outAmount, sleep);
    const stake = stakeQuote ? await arrival(options.parentStake, stakeBefore, stakeQuote.outAmount, sleep) : undefined;
    if (eth.brought === 0n || stake?.brought === 0n) {
      const holds = `${formatEther(eth.held)} ETH${stake ? ` and ${formatEther(stake.held)} of the stake token` : ""}`;
      const had = `${formatEther(ethBefore)} ETH${stake ? ` and ${formatEther(stakeBefore)}` : ""}`;
      throw new Error(`Relay reports the move settled, but the wallet on Robinhood Chain shows no increase, so what this run brought cannot be told from what it held. It holds ${holds}, and held ${had} before. Nothing was bridged.`);
    }
    // The stake goes first: its deposit pays for its arrival in ETH on the parent chain, out of what the ETH bridge would take.
    if (stake) await bridgeOn("stake", stake.brought);
    const left = await options.parentEth();
    const spent = eth.held > left ? eth.held - left : 0n;
    const ours = eth.brought > spent ? eth.brought - spent : 0n;
    const room = left > PARENT_ETH_KEEP ? left - PARENT_ETH_KEEP : 0n;
    const onward = ours < room ? ours : room;
    if (onward === 0n) log("Not enough ETH to send on to BrainChain beyond what stays for gas on Robinhood Chain.");
    else await bridgeOn("eth", onward);
  } catch (error) {
    const moved = [...onParent.values()].join(" and ");
    if (!moved) throw new Error(reason(error));
    throw new Error(`${reason(error).replace(/\.?$/, ".")} This run already brought ${moved} to ${options.worker} on Robinhood Chain; ${cli("bridge")} moves that on to BrainChain, and running fund again moves more USDC.`);
  }
  log(`Done. ${cli("status")} shows the balances on BrainChain once the deposits arrive, in about a minute.`);
}
