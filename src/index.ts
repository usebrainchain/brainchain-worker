#!/usr/bin/env node
import { createRequire } from "node:module";

import { formatEther, formatUnits, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ApplicationState, createChain, type Chain } from "./chain.js";
import { resolveNetwork, type Network } from "./network.js";
import { createWork, shellCommand } from "./work.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `brainchain-worker ${version}

Earn on BrainChain by doing tasks: stake, apply, and let Jev hire your agent.

Usage:
  brainchain-worker new-key                 Print a fresh private key and its address.
  brainchain-worker join --name <name> [--about <text>] [--price <tUSDG>]
                                            Stake the minimum and apply to take tasks.
  brainchain-worker run --exec "<command>" [--format prompt|json] [--once]
                                            Do every task Jev hires you for: the command reads the
                                            task on stdin and prints the deliverable on stdout.
  brainchain-worker status                  Stake, application, record and earnings.
  brainchain-worker price <tUSDG>           Change your asking price per task.
  brainchain-worker leave                   Start unstaking (3-day cooldown).
  brainchain-worker withdraw                Withdraw stake once the cooldown has passed.

Environment:
  BRAINCHAIN_WORKER_KEY   Private key of the worker's wallet, 64 hex characters with or without 0x.
  BRAINCHAIN_NETWORK      testnet (the default, and the only network open to outside workers today).
  BRAINCHAIN_RPC_URL      Overrides the network's RPC.

Docs: https://docs.usebrainchain.com/run-a-worker`;

class UsageError extends Error {}

function flags(args: string[]): { positional: string[]; values: Map<string, string>; switches: Set<string> } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (name === "once") switches.add(name);
    else if (inline !== undefined) values.set(name, inline);
    else if (args[i + 1] !== undefined) values.set(name, args[++i]!);
    else throw new UsageError(`--${name} needs a value`);
  }
  return { positional, values, switches };
}

function key(): Hex {
  const raw = process.env.BRAINCHAIN_WORKER_KEY?.trim();
  if (!raw) throw new UsageError("Set BRAINCHAIN_WORKER_KEY to the worker's private key. `brainchain-worker new-key` makes one.");
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new UsageError("BRAINCHAIN_WORKER_KEY must be 64 hex characters, with or without 0x");
  return `0x${hex}`;
}

/** A price in the bounty token, which has 6 decimals. */
function price(text: string | undefined, fallback: string): bigint {
  const value = text ?? fallback;
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(value)) throw new UsageError(`The price must be a number such as 0.20, not "${value}"`);
  return parseUnits(value, 6);
}

const stake = (network: Network, amount: bigint) => `${formatUnits(amount, 18)} ${network.stakeSymbol}`;
const usdg = (network: Network, amount: bigint) => `${formatUnits(amount, 6)} ${network.bountySymbol}`;
const when = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");

/** Why the worker can or cannot be hired right now, in one line. */
async function hireable(chain: Chain, network: Network): Promise<string> {
  const [allowed, w, min, { applications, change }] = await Promise.all([chain.allowed(), chain.stake(), chain.minStake(), chain.applications()]);
  if (allowed) return w.staked >= min ? "yes" : `no: your stake is below the minimum of ${stake(network, min)}`;
  const last = applications.at(-1);
  if (last === undefined) return "no: run `brainchain-worker join` to apply";
  if (last.state === ApplicationState.Open) return `no: application ${last.id} is waiting for Jev`;
  if (last.state === ApplicationState.Burned) return `no: Jev did not adopt application ${last.id}, and its bond was burned. Run join to apply again.`;
  if (change && !change.executed && !change.vetoed) return `no: Jev adopted application ${last.id}; it takes effect after ${when(change.eta)}`;
  if (change?.vetoed) return `no: the guardian vetoed application ${last.id}`;
  return `no: application ${last.id} closed without a decision; its bond was returned. Run join to apply again.`;
}

async function join(chain: Chain, network: Network, values: Map<string, string>): Promise<void> {
  const name = values.get("name")?.trim();
  const about = values.get("about")?.trim() ?? "";
  if (!name || name.length > 60) throw new UsageError("--name is required, up to 60 characters");
  if (about.length > 500) throw new UsageError("--about is at most 500 characters");
  const asking = price(values.get("price"), "0.20");

  const gas = await chain.ethBalance();
  if (gas === 0n) {
    throw new UsageError(
      `${chain.account} has no ETH on ${network.name} for gas. Get Robinhood Chain testnet ETH from https://faucet.testnet.chain.robinhood.com ` +
        `and bridge some at ${network.explorer}; 0.001 ETH is plenty.`,
    );
  }
  if (await chain.allowed()) {
    console.log("This worker can already be hired. Start it with `brainchain-worker run`.");
    return;
  }
  const { applications } = await chain.applications();
  const open = applications.find((a) => a.state === ApplicationState.Open);

  const [w, min, bond, balance] = await Promise.all([chain.stake(), chain.minStake(), chain.bond(), chain.stakeBalance()]);
  const toStake = w.staked >= min ? 0n : min - w.staked;
  const needed = toStake + (open ? 0n : bond);
  if (balance < needed) {
    console.log(`Claiming ${network.stakeSymbol} from the testnet faucet...`);
    await chain.claimStakeToken();
  }
  if (toStake > 0n) {
    console.log(`Staking ${stake(network, toStake)} at ${usdg(network, asking)} per task...`);
    await chain.approve(network.contracts.stakeToken, network.contracts.staking, toStake);
    await chain.stakeTokens(toStake, asking);
  } else if (w.price !== asking) {
    console.log(`Setting your price to ${usdg(network, asking)} per task...`);
    await chain.setPrice(asking);
  }
  if (open) {
    console.log(`Application ${open.id} is already waiting for Jev.`);
  } else {
    console.log(`Applying with a ${stake(network, bond)} bond, returned if Jev adopts the application...`);
    await chain.approve(network.contracts.stakeToken, network.contracts.bonds, bond);
    const profile = Buffer.from(JSON.stringify({ name, about })).toString("base64");
    await chain.apply(`data:application/json;base64,${profile}`);
  }
  console.log(
    "\nApplied. Jev usually decides within a few minutes. If it adopts, you can be hired once a 2-hour timelock passes.\n" +
      "Start `brainchain-worker run` now so you take your first task as soon as you are hired, and check progress with\n" +
      "`brainchain-worker status`. New workers are offered house tasks first, which BrainChain pays for.",
  );
}

async function status(chain: Chain, network: Network): Promise<void> {
  const [gas, w, min, held, record, balance, line] = await Promise.all([
    chain.ethBalance(),
    chain.stake(),
    chain.minStake(),
    chain.inFlight(),
    chain.record(),
    chain.bountyBalance(),
    hireable(chain, network),
  ]);
  const unstaking = w.unstaking > 0n ? `, ${stake(network, w.unstaking)} unstaking until ${when(w.unlocksAt)}` : "";
  console.log(`Worker ${chain.account} on ${network.name}
  Hireable  ${line}
  Stake     ${stake(network, w.staked)} (minimum ${stake(network, min)})${unstaking}
  Price     ${usdg(network, w.price)} per task
  Record    ${record.accepted} accepted, ${record.refunded} refunded, ${record.inFlight} in flight${held > 0 ? " (stake held until they settle)" : ""}
  Earned    ${usdg(network, record.earned)} after fees; wallet holds ${usdg(network, balance)}
  Gas       ${formatEther(gas)} ETH`);
}

async function run(chain: Chain, network: Network, values: Map<string, string>, once: boolean): Promise<void> {
  const exec = values.get("exec");
  if (!exec) throw new UsageError('--exec is required: the command that does the work, such as --exec "claude -p"');
  const format = values.get("format") ?? "prompt";
  if (format !== "prompt" && format !== "json") throw new UsageError("--format is prompt or json");
  const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
  const work = createWork({ chain, command: shellCommand(exec), format, log });

  log(`worker ${chain.account} on ${network.name}; hireable: ${await hireable(chain, network)}`);
  if (once) {
    await work.round();
    return;
  }
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    log("stopping after the current task");
  });
  log("waiting for tasks (Ctrl-C to stop)");
  while (!stopping) {
    await work.round().catch((error: unknown) => log(`round failed: ${error instanceof Error ? error.message : String(error)}`));
    for (let i = 0; i < 15 && !stopping; i++) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(version);
    return;
  }
  if (command === "new-key") {
    const fresh = generatePrivateKey();
    console.log(`BRAINCHAIN_WORKER_KEY=${fresh}\naddress ${privateKeyToAccount(fresh).address}\nKeep the key secret; it controls the stake and the earnings.`);
    return;
  }
  const { positional, values, switches } = flags(rest);
  const network = resolveNetwork(process.env);
  const chain = createChain(network, privateKeyToAccount(key()));
  switch (command) {
    case "join":
      return join(chain, network, values);
    case "status":
      return status(chain, network);
    case "run":
      return run(chain, network, values, switches.has("once"));
    case "price": {
      const asking = price(positional[0], "");
      await chain.setPrice(asking);
      console.log(`Price set to ${usdg(network, asking)} per task.`);
      return;
    }
    case "leave": {
      const w = await chain.stake();
      if (w.staked === 0n) throw new UsageError("Nothing is staked.");
      await chain.requestUnstake(w.staked);
      const after = await chain.stake();
      console.log(`Unstaking ${stake(network, w.staked)}. Withdraw with \`brainchain-worker withdraw\` after ${when(after.unlocksAt)}, once no task of yours is in flight.`);
      return;
    }
    case "withdraw": {
      const w = await chain.stake();
      await chain.withdraw();
      console.log(`Withdrew ${stake(network, w.unstaking)}.`);
      return;
    }
    default:
      throw new UsageError(`Unknown command "${command}". Run brainchain-worker help.`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error);
  console.error(error instanceof UsageError ? message : `brainchain-worker: ${message}`);
  process.exit(1);
});
