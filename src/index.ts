#!/usr/bin/env node
import { createRequire } from "node:module";

import { BaseError, formatEther, formatUnits, HttpRequestError, parseUnits, type Hex, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ApplicationState, createChain, type Chain } from "./chain.js";
import { resolveNetwork, type Network } from "./network.js";
import { createWork, shellCommand } from "./work.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `brainchain-worker ${version}

Earn on BrainChain by doing tasks: stake, apply, and let Jev hire your agent.

Usage:
  brainchain-worker new-key                 Print a fresh private key and its address.
  brainchain-worker join --name <name> --about <text> [--price <tUSDG>]
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

/** The flags each command takes; `true` marks a switch, which takes no value. */
const FLAGS: Record<string, Record<string, boolean>> = {
  join: { name: false, about: false, price: false },
  run: { exec: false, format: false, once: true },
  status: {},
  price: {},
  leave: {},
  withdraw: {},
};
const POSITIONAL: Record<string, number> = { price: 1 };

function parse(command: string, args: string[]): { positional: string[]; values: Map<string, string>; switches: Set<string> } {
  const known = FLAGS[command];
  if (known === undefined) throw new UsageError(`Unknown command "${command}". Run brainchain-worker help.`);
  const positional: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const isSwitch = known[name];
    if (isSwitch === undefined) throw new UsageError(`${command} has no --${name} flag. Run brainchain-worker help.`);
    if (isSwitch) {
      switches.add(name);
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
    values.set(name, value);
  }
  if (positional.length > (POSITIONAL[command] ?? 0)) throw new UsageError(`Unexpected "${positional.at(-1)}". Run brainchain-worker help.`);
  return { positional, values, switches };
}

function account(): PrivateKeyAccount {
  const raw = process.env.BRAINCHAIN_WORKER_KEY?.trim();
  if (!raw) throw new UsageError("Set BRAINCHAIN_WORKER_KEY to the worker's private key. `npx brainchain-worker new-key` makes one.");
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new UsageError("BRAINCHAIN_WORKER_KEY must be 64 hex characters, with or without 0x");
  try {
    return privateKeyToAccount(`0x${hex}`);
  } catch {
    throw new UsageError("BRAINCHAIN_WORKER_KEY is not a valid private key. `npx brainchain-worker new-key` makes one.");
  }
}

/** A price in the bounty token, which has 6 decimals. */
function price(value: string): bigint {
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(value)) {
    throw new UsageError(`The price must be a number from 0 to 999999 with at most 6 decimals, such as 0.20, not "${value}"`);
  }
  return parseUnits(value, 6);
}

const stake = (network: Network, amount: bigint) => `${formatUnits(amount, 18)} ${network.stakeSymbol}`;
const usdg = (network: Network, amount: bigint) => `${formatUnits(amount, 6)} ${network.bountySymbol}`;
const when = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");

async function needGas(chain: Chain, network: Network): Promise<void> {
  if ((await chain.ethBalance()) > 0n) return;
  throw new UsageError(
    `${chain.account} has no ETH on ${network.name} for gas. Get Robinhood Chain testnet ETH from https://faucet.testnet.chain.robinhood.com ` +
      `and bridge some at ${network.explorer}; 0.001 ETH is plenty.`,
  );
}

/** Why the worker can or cannot be hired right now, in one line. */
async function hireable(chain: Chain, network: Network): Promise<string> {
  const [allowed, w, min, { applications, change }] = await Promise.all([chain.allowed(), chain.stake(), chain.minStake(), chain.applications()]);
  if (allowed) return w.staked >= min ? "yes" : `no: your stake is below the minimum of ${stake(network, min)}. Run join to stake again.`;
  // An allowed application waiting out its timelock outranks anything filed after it.
  if (change && !change.executed && !change.vetoed) return `no: Jev allowed this worker; it can be hired after ${when(change.eta)}`;
  const last = applications.at(-1);
  if (last === undefined) return "no: run `npx brainchain-worker join` to apply";
  if (last.state === ApplicationState.Open) return `no: application ${last.id} is waiting for Jev`;
  if (last.state === ApplicationState.Burned) return `no: Jev did not allow application ${last.id}, and its bond was burned. Run join to apply again.`;
  if (change?.vetoed) return `no: the guardian vetoed application ${last.id}`;
  return `no: application ${last.id} closed without a decision; its bond was returned. Run join to apply again.`;
}

async function join(chain: Chain, network: Network, values: Map<string, string>): Promise<void> {
  const name = values.get("name")?.trim();
  const about = values.get("about")?.trim() ?? "";
  if (!name || name.length > 60) throw new UsageError("--name is required, up to 60 characters");
  if (!about || about.length > 500) {
    throw new UsageError("--about is required, up to 500 characters: say what work your agent does. Jev reads it to decide, and refuses an empty application.");
  }
  const asking = price(values.get("price") ?? "0.20");

  await needGas(chain, network);
  if (await chain.allowed()) {
    console.log("This worker can already be hired. Start it with `npx brainchain-worker run`.");
    return;
  }
  const { applications, change } = await chain.applications();
  if (change && !change.executed && !change.vetoed) {
    console.log(`Jev already allowed this worker. It can be hired after ${when(change.eta)}; keep \`npx brainchain-worker run\` going until then.`);
    return;
  }
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
    return;
  }
  console.log(`Applying with a ${stake(network, bond)} bond, returned if Jev allows the worker...`);
  await chain.approve(network.contracts.stakeToken, network.contracts.bonds, bond);
  const profile = Buffer.from(JSON.stringify({ name, about })).toString("base64");
  await chain.apply(`data:application/json;base64,${profile}`);
  console.log(
    "\nApplied. Jev usually decides within a few minutes. If it allows the worker, it can be hired once a 2-hour timelock passes.\n" +
      "Start `npx brainchain-worker run` now so it takes its first task as soon as it is hired, and follow the application\n" +
      "with `npx brainchain-worker status`. New workers are offered house tasks first, which BrainChain pays for.",
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
  Price     ${w.registered ? `${usdg(network, w.price)} per task` : "not set until you join"}
  Record    ${record.accepted} accepted, ${record.refunded} refunded, ${record.inFlight} in flight${held > 0 ? " (stake held until they settle)" : ""}
  Earned    ${usdg(network, record.earned)} after fees; wallet holds ${usdg(network, balance)}
  Gas       ${formatEther(gas)} ETH`);
}

async function run(chain: Chain, network: Network, values: Map<string, string>, once: boolean): Promise<void> {
  const exec = values.get("exec");
  if (!exec) throw new UsageError(`--exec is required: the command that does the work, such as --exec 'claude -p --tools ""'`);
  const format = values.get("format") ?? "prompt";
  if (format !== "prompt" && format !== "json") throw new UsageError("--format is prompt or json");
  const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
  const work = createWork({ chain, command: shellCommand(exec), format, log });

  log(`worker ${chain.account} on ${network.name}; hireable: ${await hireable(chain, network)}`);
  if (once) {
    const result = await work.round();
    if (result.hired === 0) log("no task is hired to this worker right now");
    // A cron job sees a failed task as a failed run.
    if (result.failed > 0) process.exitCode = 1;
    return;
  }
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    log("stopping after the current task");
  });
  log("waiting for tasks (Ctrl-C to stop)");
  while (!stopping) {
    await work.round().catch((error: unknown) => log(`round failed: ${describe(error)}`));
    for (let i = 0; i < 15 && !stopping; i++) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || argv.includes("--help") || argv.includes("-h")) {
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
  const { positional, values, switches } = parse(command, rest);
  const network = resolveNetwork(process.env);
  const chain = createChain(network, account());
  switch (command) {
    case "join":
      return join(chain, network, values);
    case "status":
      return status(chain, network);
    case "run":
      return run(chain, network, values, switches.has("once"));
    case "price": {
      if (positional[0] === undefined) throw new UsageError("Usage: brainchain-worker price <tUSDG>, such as price 0.25");
      const asking = price(positional[0]);
      if (!(await chain.stake()).registered) throw new UsageError("This worker has not staked yet. Run join, which sets the price too.");
      await needGas(chain, network);
      await chain.setPrice(asking);
      console.log(`Price set to ${usdg(network, asking)} per task.`);
      return;
    }
    case "leave": {
      const w = await chain.stake();
      if (w.staked === 0n) {
        throw new UsageError(
          w.unstaking > 0n ? `Nothing left to unstake: ${stake(network, w.unstaking)} is already unstaking until ${when(w.unlocksAt)}.` : "Nothing is staked.",
        );
      }
      await needGas(chain, network);
      await chain.requestUnstake(w.staked);
      const after = await chain.stake();
      console.log(`Unstaking ${stake(network, w.staked)}. Withdraw with \`npx brainchain-worker withdraw\` after ${when(after.unlocksAt)}, once no task of the worker's is in flight.`);
      return;
    }
    case "withdraw": {
      const [w, held, now] = await Promise.all([chain.stake(), chain.inFlight(), chain.now()]);
      if (w.unstaking === 0n) throw new UsageError("Nothing is unstaking. Run leave first.");
      if (now < w.unlocksAt) throw new UsageError(`${stake(network, w.unstaking)} unlocks at ${when(w.unlocksAt)}. Withdraw after that.`);
      if (held > 0) throw new UsageError(`The stake is held until the worker's ${held} task${held === 1 ? "" : "s"} in flight settle.`);
      await needGas(chain, network);
      await chain.withdraw();
      console.log(`Withdrew ${stake(network, w.unstaking)}.`);
      return;
    }
  }
}

/** One readable line for an error, with the cause viem keeps apart from its summary. */
function describe(error: unknown): string {
  if (error instanceof HttpRequestError) return `Could not reach ${error.url}${error.details ? ` (${error.details})` : ""}`;
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof UsageError ? error.message : `brainchain-worker: ${describe(error)}`);
  process.exit(1);
});
