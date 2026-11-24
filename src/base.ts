// Base, for an agent whose money lives there. The worker's key is an Ethereum key, so its address is the same on Base,
// Robinhood Chain and BrainChain: `fund --from-base` spends USDC the worker's address holds on Base, and
// `exit --to-base` has the desk pay the worker on Robinhood Chain, then moves that USDG on as USDC to a wallet on Base.
// Both go through Relay's signed authorization, so neither needs ETH on the chain the money leaves.

import { createPublicClient, erc20Abi, formatUnits, isAddress, zeroAddress, type Address, type LocalAccount } from "viem";

import type { Funding } from "./fund.js";
import { cli } from "./invoked.js";
import { rpcTransport, type Network } from "./network.js";
import { createPermitMover, RELAY_APPROVAL_PROXIES, type Origin } from "./permit.js";
import { MAX_LOSS, MAX_STAKE_LOSS, NATIVE, type RelayQuote } from "./relay.js";

export const BASE: Origin & { rpc: string } = {
  chainId: 8453,
  name: "Base",
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  rpc: "https://mainnet.base.org",
};

/** Relay's depository, at the same address on Base and Robinhood Chain. */
const RELAY_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
/** Addresses no one can spend USDC from on Base. */
const NOT_WALLETS = new Set([zeroAddress, BASE.token.toLowerCase(), RELAY_DEPOSITORY, ...RELAY_APPROVAL_PROXIES]);

const usdcBalance = (rpc: string, owner: Address) =>
  createPublicClient({ transport: rpcTransport(rpc) }).readContract({ address: BASE.token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

export function createBaseFunding(account: LocalAccount, parentChainId: number, rpc = BASE.rpc, fetchImpl?: typeof fetch): Funding {
  const mover = createPermitMover({
    account,
    origin: BASE,
    destination: { chainId: parentChainId, name: "Robinhood Chain" },
    again: "fund",
    maxLoss: (currency) => (currency === NATIVE ? MAX_LOSS : MAX_STAKE_LOSS),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    chain: "Base",
    owner: account.address,
    usdcBalance: () => usdcBalance(rpc, account.address),
    feeShortfall: async () => undefined,
    preview: mover.preview,
    send: mover.send,
  };
}

/** Refuses a Base payout that cannot be made, before anything is read or signed. */
export function checkToBase(network: Network, toBase: string): Address {
  if (!isAddress(toBase, { strict: true }) || NOT_WALLETS.has(toBase.toLowerCase())) throw new Error(`"${toBase}" is not the address of a wallet on Base, so USDC sent there could not be spent`);
  if (network.id !== "mainnet") throw new Error("--to-base is mainnet only: Relay connects Base with Robinhood Chain mainnet, not the testnets");
  return toBase;
}

/** The move from the worker's USDG on Robinhood Chain to USDC on Base, as `exit --to-base` makes it. */
export interface BaseLeg {
  to: Address;
  /** The USDG the worker holds on Robinhood Chain. */
  held(): Promise<bigint>;
  preview(amount: bigint): Promise<RelayQuote>;
  send(quote: RelayQuote): Promise<string>;
}

export function createBaseLeg(network: Network, account: LocalAccount, to: Address, fetchImpl?: typeof fetch): BaseLeg {
  const bridge = network.bridge;
  const usdg = bridge?.tokens?.bounty;
  if (!bridge || !usdg) throw new Error(`${network.name}'s ${network.bountySymbol} is not on a parent chain Relay serves`);
  const mover = createPermitMover({
    account,
    origin: { chainId: bridge.chainId, name: bridge.name, token: usdg, symbol: network.bountySymbol },
    destination: { chainId: BASE.chainId, name: BASE.name },
    again: "exit --to-base",
    maxLoss: () => MAX_LOSS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const read = createPublicClient({ transport: rpcTransport(bridge.rpc) });
  return {
    to,
    held: () => read.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    preview: (amount) => mover.preview(BASE.token, amount, to),
    send: mover.send,
  };
}

/** The line that moves USDG left on Robinhood Chain on to Base. */
export const resume = (to: Address, amount: bigint) => cli(`exit --to-base ${to} --from-robinhood --amount ${formatUnits(amount, 6)}`);
