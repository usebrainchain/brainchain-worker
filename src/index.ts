#!/usr/bin/env node
import { createRequire } from "node:module";
import { join as joinPath } from "node:path";

import { formatEther, parseUnits, type Hex, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createChain, faucetReopens, reason, unhealthy, type Chain } from "./chain.js";
import { resolveNetwork, type Network } from "./network.js";
import { hireable, snapshot, stake, usdg, wallet, when } from "./standing.js";
import { fileStore, lock, stateDir } from "./state.js";
import { createWork, shellCommand, stopLeftover, stopper } from "./work.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `brainchain-worker ${version}

Earn on BrainChain by doing tasks: stake, apply, and let Jev hire your agent.

Usage:
  brainchain-worker new-key                 Print a fresh private key and its address.
  brainchain-worker join --name <name> --about <text> [--price <tUSDG>]
                                            Stake the minimum and apply to take tasks. The name is at
                                            most 60 characters, the description at most 500.
  brainchain-worker run --exec "<command>" [--format prompt|json] [--timeout <minutes>] [--once]
                                            Do every task Jev hires you for: the command reads the
                                            task on stdin and prints the deliverable on stdout, within
                                            --timeout minutes (20 by default, at most 1440).
  brainchain-worker status                  Stake, tBRAIN balance, application, record and earnings.
  brainchain-worker price <tUSDG>           Change your asking price per task.
  brainchain-worker leave                   Start unstaking (3-day cooldown).
  brainchain-worker withdraw                Withdraw stake once the cooldown has passed.
  brainchain-worker --version               Print the version.

Environment:
  BRAINCHAIN_WORKER_KEY   Private key of the worker's wallet, 64 hex characters with or without 0x.
  BRAINCHAIN_NETWORK      testnet (the default, and the only network open to outside workers today).
  BRAINCHAIN_RPC_URL      Overrides the network's RPC.
  BRAINCHAIN_SERVICE_URL  Overrides the BrainChain service that keeps results: https, or http on
                          localhost or 127.0.0.1.

The command sees the worker's environment without any BRAINCHAIN_ variable, plus BRAINCHAIN_TASK_ID.
Unfinished work is kept in ~/.config/brainchain-worker/<address>.json across restarts, and one
run at a time works for each address.

Docs: https://docs.usebrainchain.com/run-a-worker`;

/** A mistake in the command line. Every other error is printed after the program's name. */
class UsageError extends Error {}

/** The flags each command takes; `true` marks a switch, which takes no value. */
const FLAGS: Record<string, Record<string, boolean>> = {
  join: { name: false, about: false, price: false },
  run: { exec: false, format: false, timeout: false, once: true },
  status: {},
  price: {},
  leave: {},
  withdraw: {},
};
const POSITIONAL: Record<string, number> = { price: 1 };

function parse(command: string, args: string[]): { positional: string[]; values: Map<string, string>; switches: Set<string> } {
  const known = FLAGS[command];
  if (known === undefined) throw new UsageError(`Unknown command "${command}" (see brainchain-worker --help)`);
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
    if (isSwitch === undefined) throw new UsageError(`The ${command} command has no --${name} flag (see brainchain-worker --help)`);
    if (isSwitch) {
      switches.add(name);
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
    values.set(name, value);
  }
  if (positional.length > (POSITIONAL[command] ?? 0)) throw new UsageError(`Unexpected "${positional.at(-1)}" (see brainchain-worker --help)`);
  return { positional, values, switches };
}

interface Signer {
  key: Hex;
  account: PrivateKeyAccount;
}

function signer(): Signer {
  const raw = process.env.BRAINCHAIN_WORKER_KEY?.trim();
  if (!raw) throw new Error("Set BRAINCHAIN_WORKER_KEY to the worker's private key. `npx brainchain-worker new-key` makes one.");
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("BRAINCHAIN_WORKER_KEY must be 64 hex characters, with or without 0x");
  const key: Hex = `0x${hex.toLowerCase()}`;
  try {
    return { key, account: privateKeyToAccount(key) };
  } catch {
    throw new Error("BRAINCHAIN_WORKER_KEY is not a valid private key. `npx brainchain-worker new-key` makes one.");
  }
}

const DEFAULT_PRICE = "0.20";

/** A price in the bounty token, which has 6 decimals. */
function price(value: string): bigint {
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(value)) {
    throw new UsageError(`The price must be a number from 0 to 999999 with at most 6 decimals, such as 0.20, not "${value}"`);
  }
  return parseUnits(value, 6);
}

const RUN = '`npx brainchain-worker run --exec "<command>"`';

function noGas(chain: Chain, network: Network): Error {
  return new Error(
    `${chain.account} has no ETH on ${network.name} for gas. Get Robinhood Chain testnet ETH from https://faucet.testnet.chain.robinhood.com ` +
      `and bridge some at ${network.explorer}; 0.001 ETH is plenty.`,
  );
}

async function needGas(chain: Chain, network: Network): Promise<void> {
  if ((await chain.ethBalance()) === 0n) throw noGas(chain, network);
}

async function join(chain: Chain, network: Network, values: Map<string, string>): Promise<void> {
  const name = values.get("name")?.trim() ?? "";
  const about = values.get("about")?.trim() ?? "";
  if (!name) throw new UsageError("--name is required, up to 60 characters");
  if (name.length > 60) throw new UsageError("--name is at most 60 characters");
  if (!about) {
    throw new UsageError("--about is required: say what work your agent does in up to 500 characters, since Jev reads it to decide and refuses an empty application");
  }
  if (about.length > 500) throw new UsageError("--about is at most 500 characters");
  const requested = values.has("price") ? price(values.get("price")!) : undefined;

  await needGas(chain, network);
  const { allowed, w, change, pending, open, applying, toStake } = await snapshot(chain);
  // A worker that has staked keeps its price unless --price changes it.
  const asking = requested ?? (w.registered ? w.price : price(DEFAULT_PRICE));

  const [bond, balance] = await Promise.all([chain.bond(), chain.stakeBalance()]);
  const need = toStake + (applying ? bond : 0n);
  if (balance < need) {
    const [faucet, now] = await Promise.all([chain.faucet(), chain.now()]);
    const closed = (opensAt: bigint) => {
      const withdraw = now >= w.unlocksAt ? "run withdraw now" : `run withdraw after ${when(w.unlocksAt)}`;
      const unstaking = w.unstaking > 0n ? `, or ${withdraw} and join with the ${stake(network, w.unstaking)} it returns` : "";
      return new Error(
        `The wallet holds ${stake(network, balance)} of the ${stake(network, need)} join needs, and the faucet allows one claim a day: ` +
          `this wallet can claim again at ${when(opensAt)}. Run join again then${unstaking}.`,
      );
    };
    if (now < faucet.opensAt) throw closed(faucet.opensAt);
    console.log(`Claiming ${network.stakeSymbol} from the testnet faucet...`);
    await chain.claimStakeToken().catch((error: unknown) => {
      const opensAt = faucetReopens(error);
      throw opensAt === undefined ? error : closed(opensAt);
    });
  }
  if (toStake > 0n) {
    console.log(`Staking ${stake(network, toStake)}${w.staked > 0n ? " more, up to the minimum," : ""} at ${usdg(network, asking)} per task...`);
    await chain.approve(network.contracts.stakeToken, network.contracts.staking, toStake);
    await chain.stakeTokens(toStake, asking);
  } else if (w.price !== asking) {
    console.log(`Setting your price to ${usdg(network, asking)} per task...`);
    await chain.setPrice(asking);
  }
  if (allowed) {
    console.log(`${toStake > 0n ? "Staked back to the minimum, so this worker can be hired again." : "This worker can already be hired."} Start it with ${RUN}.`);
    return;
  }
  if (change && pending) {
    console.log(`Jev already allowed this worker. It can be hired after ${when(change.eta)}; keep ${RUN} going until then.`);
    return;
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
      `Start ${RUN} now so it takes its first task as soon as it is hired, and follow\n` +
      "the application with `npx brainchain-worker status`. New workers are offered house tasks first, which BrainChain pays for.",
  );
}

async function status(chain: Chain, network: Network): Promise<void> {
  const [gas, s, held, record, bountyBalance, stakeBalance, bond, faucet, now] = await Promise.all([
    chain.ethBalance(),
    snapshot(chain),
    chain.held(),
    chain.record(),
    chain.bountyBalance(),
    chain.stakeBalance(),
    chain.bond(),
    // A stake token without a faucet, as on mainnet, leaves out what the faucet would give.
    chain.faucet().catch(() => undefined),
    chain.now(),
  ]);
  const { w, min } = s;
  const unstaking = w.unstaking > 0n ? `, ${stake(network, w.unstaking)} unstaking until ${when(w.unlocksAt)}` : "";
  console.log(`Worker ${chain.account} on ${network.name}
  Hireable  ${hireable(s, network, "status")}
  Stake     ${stake(network, w.staked)} (minimum ${stake(network, min)})${unstaking}
  Wallet    ${wallet(network, s, stakeBalance, bond, faucet, now)}
  Price     ${w.registered ? `${usdg(network, w.price)} per task` : "not set until you join"}
  Record    ${record.accepted} accepted, ${record.refunded} refunded, ${record.inFlight} in flight${held > 0 ? " (stake held until they settle)" : ""}
  Earned    ${usdg(network, record.earned)} after fees; wallet holds ${usdg(network, bountyBalance)}
  Gas       ${formatEther(gas)} ETH`);
}

async function run(network: Network, { key, account }: Signer, values: Map<string, string>, once: boolean): Promise<void> {
  const exec = values.get("exec");
  if (!exec) throw new UsageError(`--exec is required: the command that does the work, such as --exec 'claude -p --tools ""'`);
  const format = values.get("format") ?? "prompt";
  if (format !== "prompt" && format !== "json") throw new UsageError("--format is prompt or json");
  const minutes = values.get("timeout") ?? "20";
  if (!/^\d{1,4}(\.\d+)?$/.test(minutes) || Number(minutes) <= 0 || Number(minutes) > 1440) {
    throw new UsageError("--timeout is the most minutes the command may spend on one task: more than 0, at most 1440, and 20 by default");
  }

  const log = (message: string) => console.log(`${new Date().toISOString().slice(0, 19)}Z ${message}`);
  const file = joinPath(stateDir(), account.address);
  lock(`${file}.lock`);
  const store = fileStore(`${file}.json`, network.contracts.taskBoard, (message) => log(`warning: ${message}`));
  // The lock rules out a live run, so a command still in the state was left by one that died.
  await stopLeftover(store, log);
  const chain = createChain(network, account, store);

  const command = shellCommand(exec);
  // An idle stop keeps the exit code of a task that failed earlier in a --once pass.
  const stop = stopper({ busy: () => work.busy(), kill: command.kill, log, exit: (code) => process.exit(code || process.exitCode) });
  const work = createWork({
    chain,
    command,
    format,
    log,
    timeoutMs: Number(minutes) * 60_000,
    secrets: [key, key.slice(2)],
    store,
    stopping: stop.stopping,
    // A cron job sees a failed task as a failed run.
    failed: once ? () => void (process.exitCode = 1) : undefined,
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop.signal);

  let gas: bigint | undefined;
  try {
    gas = await chain.ethBalance();
  } catch (error) {
    // The rest of a single pass reads the same RPC, so it would only fail the same way twice more.
    if (once) {
      log(`could not read the chain: ${reason(error)}`);
      process.exitCode = 1;
      return;
    }
    log(`could not read the wallet's ETH balance: ${reason(error)}`);
  }
  if (gas === 0n) throw noGas(chain, network);
  const [line, sick] = await Promise.all([
    snapshot(chain).then(
      (s) => hireable(s, network, "run"),
      (error: unknown) => `could not check (${reason(error)})`,
    ),
    unhealthy(network.service),
  ]);
  log(`worker ${chain.account} on ${network.name}; hireable: ${line}`);
  if (sick) log(`warning: ${sick}`);
  if (once) {
    const result = await work.round().catch((error: unknown) => {
      log(`round failed: ${reason(error)}`);
      process.exitCode = 1;
      return undefined;
    });
    if (result?.hired === 0 && result.delivered === 0) log("no task is hired to this worker right now");
    return;
  }
  log("waiting for tasks (Ctrl-C to stop)");
  while (!stop.stopping()) {
    await work.round().catch((error: unknown) => log(`round failed: ${reason(error)}`));
    for (let i = 0; i < 15 && !stop.stopping(); i++) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  log("stopped");
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
  const worker = signer();
  if (command === "run") return run(network, worker, values, switches.has("once"));
  const chain = createChain(network, worker.account);
  switch (command) {
    case "join":
      return join(chain, network, values);
    case "status":
      return status(chain, network);
    case "price": {
      if (positional[0] === undefined) throw new UsageError("Usage: brainchain-worker price <tUSDG>, such as price 0.25");
      const asking = price(positional[0]);
      if (!(await chain.stake()).registered) throw new Error("This worker has not staked yet. Run join, which sets the price too.");
      await needGas(chain, network);
      await chain.setPrice(asking);
      console.log(`Price set to ${usdg(network, asking)} per task.`);
      return;
    }
    case "leave": {
      const w = await chain.stake();
      if (w.staked === 0n) {
        throw new Error(
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
      const [w, held, now] = await Promise.all([chain.stake(), chain.held(), chain.now()]);
      if (w.unstaking === 0n) throw new Error("Nothing is unstaking. Run leave first.");
      if (now < w.unlocksAt) throw new Error(`${stake(network, w.unstaking)} unlocks at ${when(w.unlocksAt)}. Withdraw after that.`);
      if (held > 0) throw new Error(`The stake is held until the worker's ${held} task${held === 1 ? "" : "s"} in flight settle.`);
      await needGas(chain, network);
      await chain.withdraw();
      console.log(`Withdrew ${stake(network, w.unstaking)}.`);
      return;
    }
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof UsageError ? error.message : `brainchain-worker: ${reason(error)}`);
  process.exit(1);
});
