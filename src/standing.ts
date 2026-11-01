import { formatUnits } from "viem";

import { ApplicationState, type Chain } from "./chain.js";
import type { Network } from "./network.js";

export const stake = (network: Network, amount: bigint) => `${formatUnits(amount, 18)} ${network.stakeSymbol}`;
export const usdg = (network: Network, amount: bigint) => `${formatUnits(amount, 6)} ${network.bountySymbol}`;
export const when = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");

/** The worker's standing with the board and the staking contract, and what join would do about it. */
export async function snapshot(chain: Chain) {
  const [allowed, w, min, { applications, change }] = await Promise.all([chain.allowed(), chain.stake(), chain.minStake(), chain.applications()]);
  const pending = change !== undefined && !change.executed && !change.vetoed;
  const open = applications.find((a) => a.state === ApplicationState.Open);
  return {
    allowed,
    w,
    min,
    applications,
    change,
    pending,
    open,
    applying: !allowed && !pending && open === undefined,
    // Below the minimum after leave or a slash, an allowed worker cannot be hired until it stakes again.
    toStake: w.staked >= min ? 0n : min - w.staked,
  };
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** Why the worker can or cannot be hired right now, in one line for `run` or for `status`, which shows the rest itself. */
export function hireable({ allowed, w, min, applications, change, pending }: Snapshot, network: Network, from: "run" | "status"): string {
  if (allowed) {
    if (w.staked >= min) return "yes";
    return `no: your stake is below the minimum of ${stake(network, min)}. Run join to stake again${from === "run" ? "; status shows what it needs" : ""}.`;
  }
  // An allowed application waiting out its timelock outranks anything filed after it.
  if (change && pending) return `no: Jev allowed this worker; it can be hired after ${when(change.eta)}`;
  const last = applications.at(-1);
  if (last === undefined) return "no: run `npx brainchain-worker join` to apply";
  if (last.state === ApplicationState.Open) return `no: application ${last.id} is waiting for Jev`;
  if (last.state === ApplicationState.Burned) return `no: Jev did not allow application ${last.id}, and its bond was burned. Run join to apply again.`;
  if (change?.vetoed) {
    // A vetoed call can never be queued again, so the veto still stands for applications filed after it.
    const vetoed = applications.find((a) => a.decisionId === change.decisionId);
    return `no: the guardian vetoed ${vetoed ? `application ${vetoed.id}` : "allowing this worker"}`;
  }
  return `no: application ${last.id} closed without a decision; its bond was returned. Run join to apply again.`;
}

/**
 * The wallet's stake token and, below the minimum stake, where join would find
 * what it needs. A stake token without a faucet has no `faucet`.
 */
export function wallet(
  network: Network,
  s: Snapshot,
  balance: bigint,
  bond: bigint,
  faucet: { amount: bigint; opensAt: bigint } | undefined,
  now: bigint,
): string {
  const has = stake(network, balance);
  if (s.toStake === 0n) return has;
  const need = s.toStake + (s.applying ? bond : 0n);
  if (balance >= need) return `${has}, enough for the ${stake(network, need)} join needs`;
  if (faucet && now >= faucet.opensAt) return `${has}; join needs ${stake(network, need)} and claims the rest from the faucet, which gives ${stake(network, faucet.amount)} a day`;
  const reopens = faucet ? `. The faucet opens again for this wallet at ${when(faucet.opensAt)}` : "";
  const unstaking =
    s.w.unstaking > 0n ? `, and the ${stake(network, s.w.unstaking)} unstaking can be withdrawn ${now >= s.w.unlocksAt ? "now" : `after ${when(s.w.unlocksAt)}`}` : "";
  return `${has}; join needs ${stake(network, need)}${reopens}${unstaking}`;
}

/** What join says when the wallet holds too little of a stake token that has no faucet. */
export function shortOfStake(network: Network, w: Snapshot["w"], balance: bigint, need: bigint, now: bigint): string {
  const withdraw = now >= w.unlocksAt ? "now" : `after ${when(w.unlocksAt)}`;
  const unstaking = w.unstaking > 0n ? ` Or run withdraw ${withdraw} and join with the ${stake(network, w.unstaking)} it returns.` : "";
  return `The wallet holds ${stake(network, balance)} of the ${stake(network, need)} join needs. ${network.buyStake}${unstaking}`;
}
