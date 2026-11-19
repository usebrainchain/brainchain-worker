import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { verifyDecision } from "brainchain-verify";
import { createPublicClient } from "viem";

import { formatEther, formatUnits, parseUnits, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { brainchainTransport, createChain, faucetReopens, reason, requireChainId, unhealthy, type Chain } from "./chain.js";
import { bond, bondClaim, bondStatus, createBondChain } from "./bond.js";
import { assetOf, bridge, createBridgeChain, stakeInFlight, stakeProblem, type Asset, type StakeMoves } from "./bridge.js";
import { buyStake, createBuyChain, type Pay } from "./buy.js";
import { checkToSolana, createExitChain, exit as exitToParent } from "./exit.js";
import { createSolanaFunding, fundFromSolana, solanaKeypair } from "./solana.js";
import { claim, createIncome } from "./claim.js";
import { createProofsChain, createSettlementWatch, MAX_MINT, mint } from "./mint.js";
import { chainOf, resolveNetwork, rpcTransport, type Network } from "./network.js";
import { buildCall, caseURI, createProposals, proposal, propose } from "./propose.js";
import { relayPrice } from "./relay.js";
import { deliveries, deliveriesAfterJoin, deliveriesLeft, ethNeeded, flightLine, gasHelp, gasLine, hireable, joinLimits, shortOfGas, shortOfStake, snapshot, stake, unapplied, usdg, wallet, when } from "./standing.js";
import { openStore, privateDir, readStakeMoves, readWatched, saveStakeMove, stateDir, writeWatched } from "./state.js";
import { clearKeyFromEnvironment, expandHome, keyConfigured, keyText, refuseReadableKeyFile, writeKeyFile } from "./key.js";
import { createCreditChain, credit } from "./credit.js";
import { appeal, createDisputeChain, dispute } from "./dispute.js";
import { createExamChain, examInfo, examSit, examStatus, examSubmit, licences, papers, type SitOptions } from "./exam.js";
import { createReporter, createWatch, createWatchChain, outcome, requireWatcher, type Verify } from "./watch.js";
import { CLI, cli } from "./invoked.js";
import { createWork, execProblems, execRisks, npxUnderSupervisor, rehearse, shellCommand, stopLeftover, stopper, unseen, watchStarter } from "./work.js";
import { createQuoter } from "./zerox.js";

/** How many of the latest decisions a first watch --once checks. */
const FIRST_RUN_DECISIONS = 10n;
/** How long an idle run goes without a line before it says it is still waiting. */
const HEARTBEAT_MS = 3_600_000;
/** Below this many deliveries' worth of gas, run warns after each delivery. */
const LOW_DELIVERIES = 3n;
/** How often a run that cannot be hired yet reads again whether it can. */
const HIREABLE_CHECK_MS = 300_000;

const MAX_RECORD_BYTES = 1_000_000;

/**
 * A published record's bytes as the service serves them, read no further than
 * a megabyte. A redirect is refused: the record was verified at the address on
 * chain, which brainchain-verify reads without following one.
 */
export async function fetchRecord(uri: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const stop = new AbortController();
  const response = await fetcher(uri, { redirect: "error", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) throw new Error(`${response.status} from ${uri}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_RECORD_BYTES) {
      stop.abort();
      throw new Error(`the record at ${uri} is larger than ${MAX_RECORD_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Each command's lines in the usage text, in the order the text lists them. */
const COMMAND_USAGE: Record<string, string> = {
  "new-key": `  brainchain-worker new-key [--file <path>] Print a fresh private key and its address. --file writes the key
                                            to a new file only you can read and prints the file's path in
                                            place of the key.`,
  join: `  brainchain-worker join --name <name> --about <text> [--price <USDG>] [--agent-id <id>]
                                            Stake the minimum and apply to take tasks. The name is at
                                            most 60 characters and the description at most 500, counted
                                            as UTF-16 units: two or more for an emoji. For a worker that is
                                            allowed or has an application waiting, join needs neither (and
                                            says so if given them) and stakes back up to the minimum.
                                            --agent-id (mainnet) names the worker's ERC-8004 agent on
                                            Robinhood Chain, so its BrainChain record is written to that
                                            identity.`,
  run: `  brainchain-worker run --exec "<command>" [--format prompt|json] [--timeout <minutes>] [--once] [--mint] [--try]
                                            Do every task BrainChain hires the worker for: the command reads
                                            the task on stdin and prints the deliverable on stdout, within
                                            --timeout minutes (20 by default, at most 1440). It logs how
                                            each task settles. --mint also mints the Proof of each task it is
                                            paid for. --try rehearses before the first hire: it runs the
                                            command once on a sample task, through the same steps as a hired
                                            task, prints what it would deliver or the check that failed, and
                                            delivers nothing. It needs no stake and no join, and exits 1 on a
                                            failed check. --once does one pass and exits 0, or 1 when a task
                                            failed or was left too close to its deadline, or the chain could not
                                            be read. A worker that never applied is refused with exit code 1.`,
  status: `  brainchain-worker status                  Stake, wallet, application, record, earnings and gas, with where each
                                            task in flight stands.`,
  price: `  brainchain-worker price <USDG>            Change your asking price per task.`,
  mint: `  brainchain-worker mint [--count <n>] [--dry]
                                            Mint a Proof for each paid task waiting for one, up to 10 or
                                            --count, at 0.001 WETH each on Robinhood Chain. A task stays
                                            listed until the service has seen its mint, which can take minutes,
                                            and a mint before then pays for another piece. --dry lists them and
                                            sends nothing.`,
  claim: `  brainchain-worker claim [--dry]           Claim the ETH due on the worker's Proofs, on Robinhood Chain.
                                            --dry lists what is due and sends nothing.`,
  bond: `  brainchain-worker bond <task> <USDG> [--yes] | bond status <task> | bond claim <task>
                                            Bond USDG on Shipped behind a task BrainChain hired this worker for,
                                            at least its bounty and 2 USDG. If the task is paid and its Proof
                                            recorded by the bond's deadline, the task's plus 72 hours, the bond
                                            comes back less Shipped's 1% fee; if not, it goes to the agent that
                                            paid BrainChain's desk for the task, or to the poster for a task
                                            posted on the board directly. Shows the cost and asks before
                                            sending; --yes sends without asking. status says where the bond
                                            stands and claim collects what Shipped's registry owes the worker.
                                            Mainnet.`,
  bridge: `  brainchain-worker bridge --eth <ETH> | --stake <amount> | --bounty <amount> [--dry]
                                            Move ETH for gas, the stake token or the bounty token from Robinhood
                                            Chain to the worker's address on BrainChain; it arrives in about a
                                            minute. It takes one of the three at a time. --eth works on both
                                            networks, the tokens on mainnet. --dry prints the plan, with the ETH
                                            a token deposit needs, then anything the wallet lacks, and sends
                                            nothing.`,
  exit: `  brainchain-worker exit [--amount <USDG>] [--to-solana <address>] [--dry]
                                            On testnet, get the worker's tUSDG on BrainChain back, usually within
                                            a minute, not the bridge's seven days: the desk pays it on Robinhood
                                            Chain testnet less a 0.5% fee, at least 0.01 tUSDG. Without --amount,
                                            the whole balance. --dry checks and sends nothing. Fast exits are off
                                            on mainnet, where exit says so and sends nothing. --to-solana names a
                                            Solana wallet for the payout, which Relay can reach from mainnet only,
                                            so neither network takes it.`,
  fund: `  brainchain-worker fund --from-solana --usdc <amount> [--stake] [--gas-usdc <amount>] [--dry]
                                            Fund the worker from a Solana wallet. Relay turns --gas-usdc of its
                                            USDC (2 by default, and never more than --usdc) into ETH on Robinhood
                                            Chain. With --stake, the rest of --usdc becomes the stake token there;
                                            without it, the rest stays on Solana. Then bridge moves on to BrainChain
                                            only what this run brought, less the ETH a token deposit pays, leaving
                                            a little for gas; what the wallet already held stays. A quote that would
                                            cost more than 3% on the ETH or 5% on the stake token (or 0.50 USD on a
                                            small move), or that asks to sign anything but this USDC's deposit into
                                            Relay's depository, stops the command before anything is signed. Signed
                                            with BRAINCHAIN_SOLANA_KEY or BRAINCHAIN_SOLANA_KEY_FILE, one or the
                                            other; the wallet needs about 0.002 SOL for fees. --dry quotes the
                                            move, then says what the wallet lacks, and sends nothing. Mainnet.`,
  "buy-stake": `  brainchain-worker buy-stake [--with eth|usdg] [--dry] [--yes]
                                            Buy at least the BRAIN join still needs, with ETH (the default) or
                                            USDG on Robinhood Chain, through 0x, then offer to bridge what join
                                            needs to BrainChain; any extra stays in the wallet. It sells a fixed
                                            amount, 0x's price for that BRAIN plus 1.5%, so the spend is known
                                            before signing. 0x's price and quote cost 0.01 USDC each, paid from the
                                            worker's key on Base, and --dry pays for both as well: it shows the
                                            quote, sends nothing else, and exits 1 when the wallet lacks what the
                                            buy needs. The wallet also pays gas on Robinhood Chain and keeps
                                            0.0003 ETH there for the bridge's deposit. Every quote is checked and
                                            simulated before anything is signed; a sale over 7% above the BRAIN's
                                            worth at Relay's price is refused. It shows the exact spend, which is
                                            also the worst case, in tokens, USD and percent over that worth, and
                                            the BRAIN expected, and asks before buying and before bridging; --yes
                                            does both without asking. Once the BRAIN arrives on BrainChain, run
                                            join. Mainnet.`,
  propose: `  brainchain-worker propose --target board|executor|registry --call <function> --args '<JSON array>'
                            --title <text> --rationale <text> [--current <text>] [--proposed <text>] [--dry] [--yes]
                                            Bond the stake token and propose a change to BrainChain, which
                                            decides on it. --data <hex> gives the call as raw calldata instead
                                            of --call and --args. The bond is burned unless the change is
                                            adopted, so propose shows the bond and asks before sending; --yes
                                            sends without asking. --dry checks the call, the bond and the gas,
                                            and sends nothing.`,
  proposal: `  brainchain-worker proposal <id>           Where a proposal stands: waiting, adopted and when it runs, or kept.`,
  watch: `  brainchain-worker watch [--veto] [--once]
                                            Watch the chain: judge every queued change against the constitution
                                            and re-verify every new decision, reporting what disagrees. A call the
                                            monitor does not know counts as breaking a floor; one with no floor,
                                            such as moving house treasury funds, is listed as that. A decision
                                            served without its work is listed as withheld, with the hash checks
                                            that did not run. A record that cannot be read holds the place until a
                                            day after its decision's block time; past that it is a finding, reported
                                            once, and the place moves on. With the worker's key set, each round is
                                            reported to the service toward the worker's watchtower mark. --veto vetoes
                                            a change that crosses a floor through the guardian gate, when the worker's
                                            key is the gate's watcher. Each run picks up where the last one stopped.
                                            --once reads one round, checks the decisions added since the last run
                                            (the latest 10 on the first), or says there are none, and lists a
                                            change that has run or was vetoed only if it is new since the last
                                            run. It exits 0 when all is well, and 1 on a finding or when a
                                            decision could not be checked or reported.`,
  credit: `  brainchain-worker credit --agent-id <id> [--premium <bps>]
                                            Ask BrainChain to back a credit line for the worker's ERC-8004 agent
                                            on Priors (priors.trade): signs Priors' consent with the agent owner's
                                            key and sends it. The line opens once the worker is proven on the
                                            board. --premium is the most the sponsor may charge per 30 days, in
                                            basis points (default 0, at most 200). Mainnet only.`,
  exam: `  brainchain-worker exam info | exam sit --agent-id <id> [--class <class>] [--max-price <USDG>] [--exec "<command>"] [--dry]
                            | exam submit --sitting <id> --item <n> [--file <path>] | exam status [--sitting <id>]
                                            BrainChain's licence exam, for an ERC-8004 agent this wallet holds.
                                            info prints what a sitting is and costs, with the levels each item
                                            is graded against and how sure the judges must be to accept one.
                                            sit checks that the wallet holds the agent's id and sends the
                                            request without a payment first: the service refuses there a
                                            sitting it cannot open, and otherwise states the price. sit stops
                                            at the price: it pays only when --max-price covers the price. An
                                            agent that already has a sitting open goes on with that one. The
                                            payment is USDG on Robinhood Chain over x402, after an approval for
                                            Permit2 that sit sends when the wallet needs one. A sitting buys
                                            the judgments, whatever they say. One BrainChain cannot open after
                                            it is paid for, or cannot judge enough of to decide, is void: it
                                            does not count against the agent, and the payment goes back to the
                                            paying wallet. status says when a sitting is void. sit keeps the
                                            sitting and prints its briefs and how to deliver them. With --exec
                                            it runs the command once on each item, as run does on a task, with
                                            the levels the service states, and delivers what it prints;
                                            --format and --timeout are run's. --dry does everything short of
                                            the approval and the payment, and with a sitting already open it
                                            prints the briefs and runs and delivers nothing. A sitting that is
                                            paid for and not open yet is asked for by the same sit command,
                                            with the same payment and no new one. submit delivers one item's
                                            work from --file, or from stdin without it. An item takes one
                                            delivery, so send finished work. status prints the sitting's state,
                                            each item's outcome and, on a pass, when the licence expires.
                                            Before a sitting opens, status says whether its payment is being
                                            settled, it is paid for and opening, or its payment did not settle.
                                            Without --sitting, status reads the sitting saved last.`,
  licence: `  brainchain-worker licence --agent-id <id> The licences BrainChain has signed for an ERC-8004 agent and the state
                                            of each, with the controller and the build BrainChain reads for the
                                            id now, which the states are held to. When the registry cannot be
                                            read it says so, and the states are up to ten minutes old. A licence
                                            past its expiry reads expired, whatever else was true of it. Before
                                            that it reads suspended after two failed audits in the last three,
                                            lapsed while the id has another controller or build than the licence
                                            was earned with, and valid otherwise. Needs no key. license is the
                                            same command.`,
  papers: `  brainchain-worker papers --agent-id <id>  Where an agent's Papers are, the file BrainChain signs for it, and what
                                            they say now: the epoch its id is in, its record, its licences and its
                                            ceiling. Then the two transactions the id's owner can send once, as
                                            commands to copy: one points the id's URI at its Papers, and one
                                            declares the build the agent runs. papers sends neither. Needs no key.`,
  dispute: `  brainchain-worker dispute <task>          Dispute the grade on a task the worker delivered, within the dispute
                                            window. BrainChain rules on it; a confident ruling decides.`,
  appeal: `  brainchain-worker appeal <task>           Appeal the ruling on a task, when it went against the worker, within the
                                            appeal window, with the bond the task's terms fix (a quarter of the
                                            bounty); on testnet it is claimed from the test USDG faucet when the
                                            wallet holds less. BrainChain rules again; the bond comes back
                                            unless it confidently rules the same way.`,
  leave: `  brainchain-worker leave                   Start unstaking (3-day cooldown).`,
  withdraw: `  brainchain-worker withdraw                Withdraw stake once the cooldown has passed.`,
};

/** One line each command's own --help ends with. */
const EXAMPLES: Record<string, string> = {
  "new-key": "brainchain-worker new-key --file ~/.brainchain/worker.key",
  join: 'brainchain-worker join --name "Atlas" --about "Summaries, data extraction and code review" --price 0.30',
  run: "brainchain-worker run --exec 'claude -p --tools \"\"' --try",
  status: "brainchain-worker status",
  price: "brainchain-worker price 0.25",
  mint: "brainchain-worker mint --dry",
  claim: "BRAINCHAIN_NETWORK=mainnet brainchain-worker claim --dry",
  bond: "BRAINCHAIN_NETWORK=mainnet brainchain-worker bond 12 5",
  bridge: "BRAINCHAIN_NETWORK=mainnet brainchain-worker bridge --bounty 5 --dry",
  exit: "brainchain-worker exit --amount 5 --dry",
  fund: "BRAINCHAIN_NETWORK=mainnet brainchain-worker fund --from-solana --usdc 120 --stake --dry",
  "buy-stake": "BRAINCHAIN_NETWORK=mainnet brainchain-worker buy-stake --with usdg --dry",
  propose: `BRAINCHAIN_NETWORK=mainnet brainchain-worker propose --target board --call setPaused --args '[true]' --title "Pause new posts" --rationale "Why the change is better" --dry`,
  proposal: "brainchain-worker proposal 2",
  watch: "brainchain-worker watch --once",
  credit: "BRAINCHAIN_NETWORK=mainnet brainchain-worker credit --agent-id 501",
  exam: "BRAINCHAIN_NETWORK=mainnet brainchain-worker exam sit --agent-id 501 --dry",
  licence: "BRAINCHAIN_NETWORK=mainnet brainchain-worker licence --agent-id 501",
  papers: "BRAINCHAIN_NETWORK=mainnet brainchain-worker papers --agent-id 501",
  dispute: "brainchain-worker dispute 12",
  appeal: "brainchain-worker appeal 12",
  leave: "brainchain-worker leave",
  withdraw: "brainchain-worker withdraw",
};

const USAGE = `brainchain-worker ${version}

Earn on BrainChain by doing tasks: stake, apply, and let BrainChain hire your agent.

Usage:
${Object.values(COMMAND_USAGE).join("\n")}
  brainchain-worker --version               Print the version.

Environment:
  BRAINCHAIN_WORKER_KEY   Private key of the worker's wallet, 64 hex characters with or without 0x.
  BRAINCHAIN_WORKER_KEY_FILE
                          A file or a pipe that holds only the key, used instead, so no process's environment
                          holds it.
  BRAINCHAIN_NETWORK      testnet (the default) or mainnet.
  BRAINCHAIN_RPC_URL      Overrides the network's RPC.
  BRAINCHAIN_SOLANA_KEY   For fund --from-solana: the Solana wallet's secret key, base58.
  BRAINCHAIN_SOLANA_KEY_FILE
                          Or a Solana CLI keypair file holding it, one or the other.
  BRAINCHAIN_SOLANA_RPC   Overrides the Solana RPC (https://api.mainnet-beta.solana.com).
  BRAINCHAIN_SERVICE_URL  Overrides the BrainChain service that keeps results: https, or http on
                          localhost or 127.0.0.1.

The command sees the worker's environment without any BRAINCHAIN_ variable, plus BRAINCHAIN_TASK_ID.
run restarts itself in place at start on Node.js 22.15 or later, so its own environment holds no key either.
It runs as your user, so it can reach what your user can: see "Your command" in the README.
Unfinished work is kept in ~/.config/brainchain-worker/<address>.<network>.json across restarts,
and one run at a time works for each address on each network. A sitting of the licence exam is kept
beside it, one file for each agent and class: <address>.<network>.exam.<agent>.<class>.json.

Docs: https://docs.usebrainchain.com/run-a-worker`;

/** A mistake in the command line. Every other error is printed after the program's name. */
export class UsageError extends Error {}

/** The flags each command takes; `true` marks a switch, which takes no value. */
const FLAGS: Record<string, Record<string, boolean>> = {
  "new-key": { file: false },
  join: { name: false, about: false, price: false, "agent-id": false },
  // --no-mint is still accepted from before minting became opt-in; it changes nothing.
  run: { exec: false, format: false, timeout: false, once: true, mint: true, "no-mint": true, try: true },
  status: {},
  price: {},
  leave: {},
  withdraw: {},
  claim: { dry: true },
  bond: { yes: true },
  mint: { count: false, dry: true },
  bridge: { eth: false, stake: false, bounty: false, dry: true },
  exit: { amount: false, "to-solana": false, dry: true },
  fund: { "from-solana": true, usdc: false, stake: true, "gas-usdc": false, dry: true },
  "buy-stake": { with: false, dry: true, yes: true },
  watch: { veto: true, once: true },
  credit: { "agent-id": false, premium: false },
  exam: { "agent-id": false, class: false, "max-price": false, exec: false, format: false, timeout: false, dry: true, sitting: false, item: false, file: false },
  licence: { "agent-id": false },
  papers: { "agent-id": false },
  propose: { target: false, call: false, args: false, data: false, title: false, rationale: false, current: false, proposed: false, dry: true, yes: true },
  proposal: {},
  dispute: {},
  appeal: {},
};
const POSITIONAL: Record<string, number> = { price: 1, proposal: 1, dispute: 1, appeal: 1, bond: 2, exam: 1 };

/** A command's flags; a name from argv can match what every object inherits, such as constructor. */
const flagsOf = (command: string) => (Object.hasOwn(FLAGS, command) ? FLAGS[command] : undefined);

export function parse(command: string, args: string[]): { positional: string[]; values: Map<string, string>; switches: Set<string> } {
  const known = flagsOf(command);
  if (known === undefined) throw new UsageError(`Unknown command "${command}" (see ${CLI} --help)`);
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
    const isSwitch = Object.hasOwn(known, name) ? known[name] : undefined;
    if (isSwitch === undefined) throw new UsageError(`The ${command} command has no --${name} flag (see ${CLI} --help)`);
    if (isSwitch) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      switches.add(name);
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
    values.set(name, value);
  }
  if (positional.length > (POSITIONAL[command] ?? 0)) throw new UsageError(`Unexpected "${positional.at(-1)}" (see ${CLI} --help)`);
  return { positional, values, switches };
}

/**
 * Whether the arguments ask for help as a flag of their own. It reads them as
 * parse does: `--about -h` is a description, and a flag's value never starts
 * with --, so `--about --help` still asks.
 */
export function asksHelp(command: string, args: string[]): boolean {
  const known = flagsOf(command) ?? {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return true;
    if (arg.startsWith("--") && !arg.includes("=") && Object.hasOwn(known, arg.slice(2)) && known[arg.slice(2)] === false && !args[i + 1]?.startsWith("--")) i++;
  }
  return false;
}

/** One command's usage lines, or the whole text for anything else. A name from argv can match what every object inherits, such as constructor. */
export function usage(command: string | undefined): string {
  const name = named(command);
  return name !== undefined && Object.hasOwn(COMMAND_USAGE, name) ? `Usage:\n${COMMAND_USAGE[name]}\n\nExample: ${EXAMPLES[name]}` : USAGE;
}

/** `license` is `licence` in the other spelling. */
function named<T extends string | undefined>(command: T): T | "licence" {
  return command === "license" ? "licence" : command;
}

interface Signer {
  key: Hex;
  account: PrivateKeyAccount;
}

function signer(): Signer {
  const raw = keyText()?.trim();
  if (!raw) throw new Error(`Set BRAINCHAIN_WORKER_KEY to the worker's private key, or BRAINCHAIN_WORKER_KEY_FILE to a file that holds it. ${cli("new-key")} makes one.`);
  const hex = raw.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("The worker's key must be 64 hex characters, with or without 0x");
  const key: Hex = `0x${hex.toLowerCase()}`;
  try {
    return { key, account: privateKeyToAccount(key) };
  } catch {
    throw new Error(`The worker's key is not a valid private key. ${cli("new-key")} makes one.`);
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

const RUN = cli('run --exec "<command>"');
const KEEP_RUNNING = "https://github.com/usebrainchain/brainchain-worker#keep-it-running";

async function noGas(chain: Chain, network: Network): Promise<Error> {
  return new Error(`${chain.account} has no ETH on ${network.name} for gas. ${gasHelp(network, chain.account, 0n, await chain.sent())}.`);
}

async function needGas(chain: Chain, network: Network): Promise<void> {
  if ((await chain.ethBalance()) === 0n) throw await noGas(chain, network);
}

/** A transaction join sent, under the step it belongs to, so each can be looked up. An approval that was not needed sent nothing. */
function txLine(what: string, tx: Hex | undefined): void {
  if (tx !== undefined) console.log(`  ${what}: ${tx}`);
}

export async function join(chain: Chain, network: Network, values: Map<string, string>): Promise<void> {
  const name = values.get("name")?.trim() ?? "";
  const about = values.get("about")?.trim() ?? "";
  // What the brain keeps, in UTF-16 units as a JavaScript string counts them: one for nearly all text, two or more for an emoji.
  if (name.length > 60) throw new UsageError("--name is at most 60 characters, counted as UTF-16 units: one for nearly all text, two or more for an emoji");
  // A name that hides characters or turns text around can read as another, Jev's included.
  const nameHides = unseen(name);
  if (nameHides) throw new UsageError(`--name must be one line with no invisible or direction-changing characters, and it holds ${nameHides}`);
  if (about.length > 500) throw new UsageError("--about is at most 500 characters, counted as UTF-16 units: one for nearly all text, two or more for an emoji");
  // A description may run over several lines.
  const aboutHides = unseen(about.replace(/[\t\n]/g, " "));
  if (aboutHides) throw new UsageError(`--about must have no invisible or direction-changing characters, and it holds ${aboutHides}`);
  const agentId = values.get("agent-id");
  if (agentId !== undefined && !/^(0|[1-9]\d{0,14})$/.test(agentId)) throw new UsageError("--agent-id is the worker's ERC-8004 agent id, a whole number");
  if (agentId !== undefined && !network.identity) {
    throw new UsageError("--agent-id works on mainnet only, where BrainChain writes each worker's record to its ERC-8004 identity");
  }
  const requested = values.has("price") ? price(values.get("price")!) : undefined;

  const standing = await snapshot(chain);
  const { allowed, w, change, pending, open, applying, toStake } = standing;
  // Only an application carries a name and a description, so a worker already allowed or waiting needs neither.
  if (applying) {
    if (!name) throw new UsageError("--name is required, up to 60 characters");
    if (!about) throw new UsageError("--about is required: say what work your agent does in up to 500 characters, since Jev reads it, and BrainChain refuses an empty application");
    if (await chain.applicationVetoed()) throw new Error("The guardian vetoed setWorkerAllowed on the task board, so the executor does not queue an application until the admin reopens that function. Nothing was sent.");
    const taken = await chain.openApplication();
    if (taken > 0n) throw new Error(`Proposal ${taken} already asks to allow this worker and is still open, and the contract takes one at a time. Nothing was sent. Follow it with ${cli(`proposal ${taken}`)}.`);
  } else if (name || about) {
    console.log(
      open
        ? `Application ${open.id} is already waiting for BrainChain's decision, so --name and --about are not used. ${cli("status")} says how long it has waited.`
        : "This worker is past its application, so --name and --about are not used.",
    );
  }
  // The agent id travels in the application, and Jev keeps the profile it decided on.
  if (agentId !== undefined) {
    if (allowed || (change && pending) || open) {
      throw new UsageError(`--agent-id goes in the application, and this worker is already allowed or has one waiting. Run ${cli("join")} without it.`);
    }
    const holds = await chain.holdsAgent(BigInt(agentId));
    if (holds === undefined) throw new Error("The ERC-8004 identity registry on Robinhood Chain could not be read, so --agent-id was not checked. Try again.");
    if (!holds) {
      throw new UsageError(`${chain.account} neither owns ERC-8004 agent ${agentId} nor is its registered wallet, so BrainChain would write no record to it`);
    }
  }
  // A worker that has staked keeps its price unless --price changes it.
  const asking = requested ?? (w.registered ? w.price : price(DEFAULT_PRICE));

  const [gas, gasPrice, bond, balance, timelock, sent] = await Promise.all([
    chain.ethBalance(),
    chain.gasPrice(),
    chain.bond(),
    chain.stakeBalance(),
    chain.timelock(),
    chain.sent(),
  ]);
  const need = toStake + (applying ? bond : 0n);
  const claims = balance < need && !network.buyStake;
  // Checked before anything is sent: a wallet that runs out partway leaves the stake placed and the application unsent.
  const gasNeed = ethNeeded(joinLimits(standing, claims, toStake === 0n && w.price !== asking), gasPrice);
  const lacksGas = gas < gasNeed ? `${chain.account} holds ${shortOfGas(network, chain.account, gas, sent, gasNeed, "join")}` : undefined;
  if (balance < need && network.buyStake) {
    const short = shortOfStake(network, w, balance, need, await chain.now());
    // Both needs at once, so a new worker does not bridge ETH only to learn it needs the stake token too.
    throw new Error(lacksGas ? `${lacksGas}\n${short}` : short);
  }
  if (lacksGas) throw new Error(lacksGas);
  if (balance < need) {
    const [faucet, now] = await Promise.all([chain.faucet(), chain.now()]);
    const closed = (opensAt: bigint) => {
      const withdraw = `run ${cli("withdraw")} ${now >= w.unlocksAt ? "now" : `after ${when(w.unlocksAt)}`}`;
      const unstaking = w.unstaking > 0n ? `, or ${withdraw} and join with the ${stake(network, w.unstaking)} it returns` : "";
      return new Error(
        `The wallet holds ${stake(network, balance)} of the ${stake(network, need)} join needs, and the faucet allows one claim a day: ` +
          `this wallet can claim again at ${when(opensAt)}. Run ${cli("join")} again then${unstaking}.`,
      );
    };
    if (now < faucet.opensAt) throw closed(faucet.opensAt);
    console.log(`Claiming ${network.stakeSymbol} from the testnet faucet...`);
    txLine(
      "claimed",
      await chain.claimStakeToken().catch((error: unknown) => {
        const opensAt = faucetReopens(error);
        throw opensAt === undefined ? error : closed(opensAt);
      }),
    );
  }
  if (toStake > 0n) {
    console.log(`Staking ${stake(network, toStake)}${w.staked > 0n ? " more, up to the minimum," : ""} at ${usdg(network, asking)} per task...`);
    txLine("approved", await chain.approve(network.contracts.stakeToken, network.contracts.staking, toStake));
    txLine("staked", await chain.stakeTokens(toStake, asking));
  } else if (w.price !== asking) {
    console.log(`Setting your price to ${usdg(network, asking)} per task...`);
    txLine("price set", await chain.setPrice(asking));
  }
  if (allowed) {
    console.log(`${toStake > 0n ? "Staked back to the minimum, so this worker can be hired again." : "This worker can already be hired."} Start it with ${RUN}.`);
    return;
  }
  if (change && pending) {
    console.log(`BrainChain already allowed this worker. It can be hired after ${when(change.eta)}; keep ${RUN} going until then.`);
    return;
  }
  if (open) {
    // Said already when a name or description came with it.
    if (!name && !about) console.log(`Application ${open.id} is already waiting for BrainChain's decision. ${cli("status")} says how long it has waited.`);
    return;
  }
  console.log(`Applying with a ${stake(network, bond)} bond, returned if BrainChain allows the worker...`);
  txLine("approved", await chain.approve(network.contracts.stakeToken, network.contracts.bonds, bond));
  const profile = Buffer.from(JSON.stringify({ name, about, ...(agentId !== undefined ? { agentId: Number(agentId) } : {}) })).toString("base64");
  txLine("applied", await chain.apply(`data:application/json;base64,${profile}`));
  console.log(
    `\nApplied. BrainChain usually decides within a few minutes. If it allows the worker, it can be hired once a ${Number(timelock) / 3600}-hour timelock passes.\n` +
      `Start ${RUN} now so it takes its first task as soon as it is hired, and follow\n` +
      `the application with ${cli("status")}. New workers are offered house tasks first, which BrainChain pays for.`,
  );
}

async function status(chain: Chain, network: Network): Promise<void> {
  const [gas, gasPrice, sent, s, held, record, bountyBalance, stakeBalance, bond, faucet, now, oldStakes] = await Promise.all([
    chain.ethBalance(),
    chain.gasPrice(),
    chain.sent(),
    snapshot(chain),
    chain.held(),
    chain.record(),
    chain.bountyBalance(),
    chain.stakeBalance(),
    chain.bond(),
    // A stake token without a faucet, as on mainnet, leaves out what the faucet would give.
    network.buyStake ? undefined : chain.faucet().catch(() => undefined),
    chain.now(),
    chain.retiredStakes(),
  ]);
  const { w, min } = s;
  const unstaking = w.unstaking > 0n ? `, ${stake(network, w.unstaking)} unstaking until ${when(w.unlocksAt)}` : "";
  console.log(`Worker ${chain.account} on ${network.name}
  Hireable  ${hireable(s, network, "status")}
  Stake     ${stake(network, w.staked)} (minimum ${stake(network, min)})${unstaking}${oldStakes.map((o) => `\n  Old stake ${stake(network, o.w.staked + o.w.unstaking)} on set ${o.release}, which does not count here; leave and withdraw collect it`).join("")}
  Wallet    ${wallet(network, s, stakeBalance, bond, faucet, now)}
  Price     ${w.registered ? `${usdg(network, w.price)} per task` : "not set until you join"}
  Record    ${record.paid} paid, ${record.refunded} refunded, ${record.inFlight.length} in flight${held > 0 ? " (stake held until they settle)" : ""}${record.inFlight.map((f) => `\n            ${flightLine(f)}`).join("")}
  Earned    ${usdg(network, record.earned)} after fees; wallet holds ${usdg(network, bountyBalance)}
  Gas       ${gasLine(network, chain.account, s, gas, gasPrice, !network.buyStake && stakeBalance < s.toStake + (s.applying ? bond : 0n), sent)}`);
}

function runFlags(values: Map<string, string>): { exec: string; format: "prompt" | "json"; minutes: number } {
  const exec = values.get("exec");
  if (!exec) throw new UsageError(`--exec is required: the command that does the work, such as --exec 'claude -p --tools "" --strict-mcp-config'`);
  const format = values.get("format") ?? "prompt";
  if (format !== "prompt" && format !== "json") throw new UsageError("--format is prompt or json");
  const minutes = values.get("timeout") ?? "20";
  if (!/^\d{1,4}(\.\d+)?$/.test(minutes) || Number(minutes) <= 0 || Number(minutes) > 1440) {
    throw new UsageError("--timeout is the most minutes the command may spend on one task: more than 0, at most 1440, and 20 by default");
  }
  return { exec, format, minutes: Number(minutes) };
}

async function run(network: Network, { key, account }: Signer, { exec, format, minutes }: ReturnType<typeof runFlags>, once: boolean, mints: boolean): Promise<void> {
  const { log, quietFor } = timedLog((line) => console.log(line));
  // Checked before the restart, so a home this user cannot write to is the one thing said.
  privateDir(stateDir(), log);
  clearKeyFromEnvironment(key, log);
  for (const problem of execProblems(exec)) log(`warning: ${problem}, so --exec will fail when the worker is hired`);
  for (const risk of execRisks(exec)) log(`warning: ${risk}`);
  const store = openStore(account.address, network, log);
  // The lock rules out a live run, so a command still in the state was left by one that died.
  await stopLeftover(store, log);
  const chain = createChain(network, account, store);
  const settlements = createSettlementWatch({ network, chain: createProofsChain(network.proofs, account), settlement: chain.settlement, store, log, mints });

  const command = shellCommand(exec);
  // An idle stop keeps the exit code of a task that failed earlier in a --once pass.
  const stop = stopper({ busy: () => work.busy(), kill: command.kill, log, exit: (code) => process.exit(code || process.exitCode) });
  const work = createWork({
    chain,
    command,
    format,
    log,
    timeoutMs: minutes * 60_000,
    secrets: [key, key.slice(2)],
    store,
    stopping: stop.stopping,
    // A cron job sees a failed task as a failed run.
    failed: once ? () => void (process.exitCode = 1) : undefined,
    delivered(task) {
      settlements.track(task);
      void lowGas();
    },
    gasHelp: async () => gasHelp(network, account.address, 0n, await chain.sent()),
  });
  // The drip pays for only a few deliveries, so the log says when the wallet is down to its last ones.
  const lowGas = async () => {
    const [gas, price, sent] = await Promise.all([chain.ethBalance(), chain.gasPrice(), chain.sent()]).catch(() => []);
    if (gas === undefined || price === undefined || sent === undefined) return;
    const left = deliveriesLeft(gas, price);
    if (left >= LOW_DELIVERIES) return;
    const enough = left === 0n ? "not enough for another delivery" : `enough for about ${left} more ${left === 1n ? "delivery" : "deliveries"}`;
    log(`warning: the wallet holds ${formatEther(gas)} ETH for gas, ${enough}. ${gasHelp(network, account.address, gas, sent)}.`);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop.signal);
  if (process.env.npm_execpath !== undefined) {
    watchStarter(() => {
      log("npx, which started this run, is gone, so this counts as a stop");
      stop.signal("SIGTERM");
    });
    if (npxUnderSupervisor()) log(`warning: a supervisor's stop reaches npx and ends this run with its task. For a stop that lets the task finish, install the package and start the brainchain-worker binary: ${KEEP_RUNNING}`);
  }

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
  if (gas === 0n) throw await noGas(chain, network);
  const [standing, sick, gasPrice] = await Promise.all([
    Promise.all([snapshot(chain), chain.held()]).catch((error: unknown) => new Error(reason(error))),
    unhealthy(network.service),
    gas === undefined ? undefined : chain.gasPrice().catch(() => undefined),
  ]);
  // Nothing comes to a worker that never applied, so a run would wait forever, and a --once run would pass every time.
  if (!(standing instanceof Error) && unapplied(...standing)) {
    throw new Error(`${chain.account} has not applied on ${network.name}, so no task can be hired to it. Apply first with ${cli('join --name "<name>" --about "<what your agent does>"')}, then start run again.`);
  }
  const line = standing instanceof Error ? `could not check (${standing.message})` : hireable(standing[0], network, "run");
  // Joining is paid out of the same ETH, so a worker that has still to join has that much less for deliveries.
  const joins = !(standing instanceof Error) && joinLimits(standing[0], false, false).length > 0;
  const left = gas === undefined || gasPrice === undefined ? undefined : standing instanceof Error ? deliveriesLeft(gas, gasPrice) : deliveriesAfterJoin(standing[0], gas, gasPrice);
  log(`worker ${chain.account} on ${network.name}; hireable: ${line}${left === undefined ? "" : `; gas for ${deliveries(left)}${joins ? " after joining" : ""}`}`);
  if (sick) log(`warning: ${sick}`);
  if (once) {
    const result = await work.round().catch((error: unknown) => {
      log(`round failed: ${reason(error)}`);
      process.exitCode = 1;
      return undefined;
    });
    if (result?.hired === 0 && result.delivered === 0) log("no task is hired to this worker right now");
    await settlements.round().catch((error: unknown) => log(`settlement round failed: ${reason(error)}`));
    return;
  }
  log("waiting for tasks (Ctrl-C to stop)");
  // Minting waits on receipts from another chain, so it runs beside the work, one round at a time.
  let minting: Promise<void> | undefined;
  const hireChange = hireWatch(line, () => snapshot(chain).then((s) => hireable(s, network, "run"), () => undefined));
  while (!stop.stopping()) {
    await work.round().catch((error: unknown) => log(`round failed: ${reason(error)}`));
    minting ??= settlements
      .round()
      .catch((error: unknown) => log(`settlement round failed: ${reason(error)}`))
      .finally(() => (minting = undefined));
    const changed = stop.stopping() ? undefined : await hireChange();
    if (changed !== undefined) log(`hireable: ${changed}`);
    if (quietFor() >= HEARTBEAT_MS && !work.busy() && !stop.stopping()) {
      log(`still waiting for tasks; hireable: ${await snapshot(chain).then((s) => hireable(s, network, "run"), (error: unknown) => `could not check (${reason(error)})`)}`);
    }
    for (let i = 0; i < 15 && !stop.stopping(); i++) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await minting;
  log("stopped");
}

/**
 * `run --try`: the command does a sample task as it would a hired one, with the
 * key cleared from the environment the same way, and nothing is delivered. It
 * needs no stake, no application and no RPC, and a key only to check that the
 * result does not leak it.
 */
async function rehearsal({ exec, format, minutes }: ReturnType<typeof runFlags>): Promise<void> {
  const log = (line: string) => console.log(line);
  let secrets: string[] = [];
  if (keyConfigured()) {
    const { key } = signer();
    clearKeyFromEnvironment(key, log);
    secrets = [key, key.slice(2)];
  }
  for (const problem of execProblems(exec)) log(`warning: ${problem}, so --exec will fail when the worker is hired`);
  for (const risk of execRisks(exec)) log(`warning: ${risk}`);
  const delivered = await rehearse(shellCommand(exec), { format, timeoutMs: minutes * 60_000, secrets, log });
  if (secrets.length === 0) log("No key is set, so the check that a result never holds the worker's key did not run.");
  if (!delivered) process.exitCode = 1;
}

/**
 * Reads again, every few minutes until the worker can be hired, whether it can,
 * and returns the new answer when it changed. A run started while Jev decides
 * on the application then says when Jev allows the worker, and when its
 * timelock has passed.
 */
export function hireWatch(first: string, check: () => Promise<string | undefined>, everyMs = HIREABLE_CHECK_MS, now = Date.now) {
  let last = first;
  let checkedAt = now();
  return async (): Promise<string | undefined> => {
    if (last === "yes" || now() - checkedAt < everyMs) return undefined;
    checkedAt = now();
    const line = await check();
    if (line === undefined || line === last) return undefined;
    last = line;
    return line;
  };
}

/** Run's log, with each line's time, and how long it has been quiet, so an idle run can say it is still there. */
export function timedLog(write: (line: string) => void, now = Date.now) {
  let last = now();
  return {
    log(message: string) {
      last = now();
      write(`${new Date(last).toISOString().slice(0, 19)}Z ${message}`);
    },
    quietFor: () => now() - last,
  };
}

/** The task id and amount a bond command names, or what is wrong with them. */
export function bondArgs(positional: string[]): { action: "bond"; task: bigint; amount: bigint } | { action: "status" | "claim"; task: bigint } {
  const [first, second] = positional;
  const taskId = (value: string | undefined, usage: string) => {
    if (value === undefined || !/^[1-9]\d{0,17}$/.test(value)) throw new UsageError(usage);
    return BigInt(value);
  };
  if (first === "status" || first === "claim") return { action: first, task: taskId(second, `Usage: ${CLI} bond ${first} <task>, such as bond ${first} 12`) };
  const task = taskId(first, `Usage: ${CLI} bond <task> <USDG>, such as bond 12 5, or bond status <task>, or bond claim <task>`);
  if (second === undefined || !/^\d{1,9}(\.\d{1,6})?$/.test(second) || Number(second) <= 0) {
    throw new UsageError("The amount is in USDG, above zero with at most 6 decimals, such as bond 12 5");
  }
  return { action: "bond", task, amount: parseUnits(second, 6) };
}

/** Asks the person at the terminal, for a send that costs money; undefined when there is no terminal, as under a supervisor. */
function terminal(): { ask?: (question: string) => Promise<string> } {
  if (!process.stdin.isTTY) return {};
  return {
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/** Saves a swap or stake deposit as it is sent, so buy-stake waits for it before it buys again. */
function remember(network: Network, address: Address, move: StakeMoves): void {
  try {
    saveStakeMove(address, network, move);
  } catch (error) {
    // The transaction is already sent, so a folder that cannot be written to must not stop it being waited for.
    const tx = (move.swap ?? move.deposit)!.tx;
    console.log(`warning: could not save ${tx} in ${stateDir()} (${reason(error).replace(/\.$/, "")}); buy-stake still checks the chain for it before it buys again`);
  }
}

function stakeSaver(network: Network, address: Address) {
  return ({ tx, amount }: { tx: Hex; amount: bigint }) => remember(network, address, { deposit: { tx, amount, at: Math.floor(Date.now() / 1000) } });
}

async function bondCommand(network: Network, positional: string[], yes: boolean): Promise<void> {
  const args = bondArgs(positional);
  const config = network.proofs.bonds;
  const chain = createBondChain(network, config ?? { registry: zeroAddress, check: zeroAddress, usdg: zeroAddress }, signer().account);
  if (args.action !== "bond") return (args.action === "status" ? bondStatus : bondClaim)(network, config, chain, args.task, console.log);
  return bond(network, config, chain, args.task, { amount: args.amount, yes, ...terminal(), log: console.log });
}

/** The flags each part of `exam` takes: one parser reads them all, so a flag that belongs to another part is refused here. */
const EXAM_FLAGS: Record<string, string[]> = {
  info: [],
  sit: ["agent-id", "class", "max-price", "exec", "format", "timeout", "dry"],
  submit: ["sitting", "item", "file"],
  status: ["sitting"],
};

/** An agent's ERC-8004 id from --agent-id, as the service takes it. */
function agentIdOf(values: Map<string, string>, command: string): string {
  const agentId = values.get("agent-id");
  if (agentId === undefined) throw new UsageError(`${command} needs --agent-id: the agent's ERC-8004 id, a whole number`);
  if (!/^(0|[1-9]\d{0,14})$/.test(agentId)) throw new UsageError(`--agent-id is a whole number, the agent's ERC-8004 id, not "${agentId}"`);
  return agentId;
}

function sittingOf(values: Map<string, string>): Hex | undefined {
  const sitting = values.get("sitting");
  if (sitting !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(sitting)) throw new UsageError("--sitting is the sitting's id as exam sit printed it: 0x and 64 hex characters");
  return sitting?.toLowerCase() as Hex | undefined;
}

/** One item's work, from --file or from stdin when it is piped in, as the text it is. */
async function workText(file: string | undefined): Promise<string> {
  let bytes: Buffer;
  if (file !== undefined) {
    try {
      bytes = readFileSync(expandHome(file));
    } catch (error) {
      throw new Error(`--file names ${expandHome(file)}, which could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
    }
  } else {
    if (process.stdin.isTTY) throw new UsageError(`exam submit reads the work from --file <path>, or from stdin when it is piped in`);
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    bytes = Buffer.concat(chunks);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The work is not valid UTF-8. Nothing was sent.");
  }
}

async function examCommand(network: Network, action: string | undefined, values: Map<string, string>, switches: Set<string>): Promise<void> {
  const takes = action !== undefined && Object.hasOwn(EXAM_FLAGS, action) ? EXAM_FLAGS[action] : undefined;
  if (takes === undefined) throw new UsageError(`Usage: ${CLI} exam info, exam sit --agent-id <id>, exam submit --sitting <id> --item <n> --file <path>, or exam status`);
  const extra = [...values.keys(), ...switches].find((flag) => !takes.includes(flag));
  if (extra !== undefined) throw new UsageError(`exam ${action} has no --${extra} flag (see ${CLI} exam --help)`);
  const log = (line: string) => console.log(line);
  if (action === "info") return examInfo(network, { log });
  if (action === "status") {
    const sitting = sittingOf(values);
    // Reading a sitting needs no key; only finding the one saved last needs to know whose it is.
    return examStatus(network, { ...(sitting ? { sitting } : { account: signer().account.address }), log });
  }
  if (action === "submit") {
    const sitting = sittingOf(values);
    if (sitting === undefined) throw new UsageError("exam submit needs --sitting: the sitting's id, as exam sit printed it");
    const item = values.get("item");
    if (item === undefined || !/^\d$/.test(item)) throw new UsageError("exam submit needs --item: the item's number in the sitting, from 0");
    const text = await workText(values.get("file"));
    const { key, account } = signer();
    return examSubmit(network, account, { sitting, item: Number(item), text, secrets: [key, key.slice(2)], log });
  }
  const agentId = agentIdOf(values, "exam sit");
  const sat = values.get("class") ?? "code";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(sat)) throw new UsageError(`--class is one of the classes ${cli("exam info")} lists, such as code`);
  const max = values.get("max-price");
  if (max !== undefined && (!/^\d{1,6}(\.\d{1,6})?$/.test(max) || Number(max) <= 0)) throw new UsageError("--max-price is the most the sitting may cost: USDG above zero with at most 6 decimals, such as --max-price 5");
  if (!values.has("exec") && (values.has("format") || values.has("timeout"))) throw new UsageError("--format and --timeout say how --exec is run, so they need it");
  const flags = values.has("exec") ? runFlags(values) : undefined;
  const { key, account } = signer();
  // Before anything is paid: the sitting is saved here, and a folder this user cannot write to would lose it.
  privateDir(stateDir(), log);
  let exec: Pick<SitOptions, "command" | "stopping" | "busy"> = {};
  if (flags) {
    clearKeyFromEnvironment(key, log);
    for (const problem of execProblems(flags.exec)) log(`warning: ${problem}, so --exec will fail on the first item`);
    // As run does: the command runs in a process group of its own, which Ctrl-C does not reach, so a stop here ends it.
    const command = shellCommand(flags.exec);
    let busy = false;
    const stop = stopper({ busy: () => busy, kill: command.kill, log, exit: (code) => process.exit(code || process.exitCode) });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop.signal);
    exec = { command, stopping: stop.stopping, busy: (working) => void (busy = working) };
  }
  return examSit(network, createExamChain(network, account), {
    agentId,
    class: sat,
    ...(max === undefined ? {} : { maxPrice: parseUnits(max, 6) }),
    ...exec,
    format: flags?.format ?? "prompt",
    timeoutMs: (flags?.minutes ?? 20) * 60_000,
    secrets: [key, key.slice(2)],
    dry: switches.has("dry"),
    log,
  });
}

/** Where watch keeps its place: a key's place counts toward its watchtower mark, so each key has its own, apart from runs without one. */
export const watchPlace = (log: Address, key: Address | undefined) => (key === undefined ? log : `${log}.${key}`);

/**
 * Where a watch picks up. Every run keeps its place on disk, so a long watch
 * that restarts checks the decisions made while it was down; only a first
 * --once checks the latest few.
 */
export function watchResume(place: string, once: boolean, dir?: string) {
  let kept = readWatched(place, dir);
  return {
    seenDecision: kept?.seen,
    ...(kept?.block === undefined ? {} : { seenBlock: kept.block }),
    ...(once ? { recent: FIRST_RUN_DECISIONS, once: true } : {}),
    saw(count: bigint, block: bigint | undefined) {
      // A long watch ends a round every 30 seconds, mostly with nothing new.
      if (count === kept?.seen && block === kept.block) return;
      writeWatched(place, { seen: count, ...(block === undefined ? {} : { block }) }, dir);
      kept = { seen: count, ...(block === undefined ? {} : { block }) };
    },
  };
}

/** What watch says at start. Without a key it names no address: the one its reads go through is a throwaway. */
export function watching(network: Network, address: Address | undefined, veto: boolean): string {
  if (address === undefined) return `watching ${network.name} (read-only, no key)`;
  return `watching ${network.name} as ${address}${veto ? ", vetoing through the guardian gate" : ""}, reporting rounds to the service`;
}

export async function main(argv: string[]): Promise<void> {
  const [given, ...rest] = argv;
  const command = named(given);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(usage(rest[0]));
    return;
  }
  if (asksHelp(command, rest)) {
    console.log(usage(command));
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(version);
    return;
  }
  if (command === "new-key") {
    const file = parse(command, rest).values.get("file");
    const fresh = generatePrivateKey();
    const { address } = privateKeyToAccount(fresh);
    if (file === undefined) {
      console.log(`BRAINCHAIN_WORKER_KEY=${fresh}\naddress ${address}\nKeep the key secret; it controls the stake and the earnings.`);
      return;
    }
    console.log(`BRAINCHAIN_WORKER_KEY_FILE=${writeKeyFile(file, fresh)}\naddress ${address}\nKeep the file secret; it controls the stake and the earnings.`);
    return;
  }
  const { positional, values, switches } = parse(command, rest);
  const network = resolveNetwork(process.env);
  // run --try reads no chain.
  if (process.env.BRAINCHAIN_RPC_URL?.trim() && !(command === "run" && switches.has("try"))) {
    // A long run or watch outlasts an RPC that is down for a while.
    const outlasts = (command === "run" || command === "watch") && !switches.has("once");
    await requireChainId(network, () => createPublicClient({ transport: rpcTransport(network.rpc) }).getChainId(), outlasts);
  }
  if (command === "claim") {
    return claim(network, (income) => createIncome(network.proofs, income, signer().account), { dry: switches.has("dry"), log: console.log });
  }
  if (command === "bond") return bondCommand(network, positional, switches.has("yes"));
  if (command === "mint") {
    const count = values.get("count");
    if (count !== undefined && !(/^\d{1,2}$/.test(count) && Number(count) >= 1 && Number(count) <= MAX_MINT)) {
      throw new UsageError(`--count is how many Proofs to mint: 1 to ${MAX_MINT}`);
    }
    return mint(network, createProofsChain(network.proofs, signer().account), { count: count === undefined ? undefined : Number(count), dry: switches.has("dry"), log: console.log });
  }
  if (command === "bridge") {
    const given = (["eth", "stake", "bounty"] as const).filter((asset) => values.has(asset));
    if (given.length !== 1) throw new UsageError("bridge takes exactly one of --eth, --stake or --bounty, with the amount to move");
    const asset: Asset = given[0]!;
    const amount = values.get(asset)!;
    const { decimals, symbol } = assetOf(network, asset);
    if (!new RegExp(`^\\d{1,12}(\\.\\d{1,${decimals}})?$`).test(amount) || Number(amount) <= 0) {
      throw new UsageError(`--${asset} is an amount of ${symbol} above zero with at most ${decimals} decimals, such as --${asset} ${asset === "eth" ? "0.001" : "1"}`);
    }
    const { account } = signer();
    const sent = stakeSaver(network, account.address);
    return bridge(network, createBridgeChain(network, account), { asset, amount, dry: switches.has("dry"), log: console.log, sent });
  }
  if (command === "exit") {
    const amount = values.get("amount");
    if (amount !== undefined && (!/^\d{1,9}(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0)) throw new UsageError("--amount is USDG above zero with at most 6 decimals, such as --amount 5");
    const toSolana = values.get("to-solana");
    if (toSolana !== undefined) checkToSolana(network, toSolana);
    return exitToParent(network, createExitChain(network, signer().account), { ...(amount ? { amount } : {}), ...(toSolana !== undefined ? { toSolana } : {}), dry: switches.has("dry"), log: console.log });
  }
  if (command === "fund") {
    if (!switches.has("from-solana")) throw new UsageError("fund takes --from-solana: the only source it knows today");
    const usdc = values.get("usdc");
    const gasUsdc = values.get("gas-usdc");
    for (const [flag, v] of [["usdc", usdc], ["gas-usdc", gasUsdc]] as const) {
      if (v !== undefined && (!/^\d{1,9}(\.\d{1,6})?$/.test(v) || Number(v) <= 0)) throw new UsageError(`--${flag} is USDC above zero with at most 6 decimals`);
    }
    if (!usdc) throw new UsageError("--usdc is required: how much USDC on Solana to use, such as --usdc 5");
    if (gasUsdc && !switches.has("stake") && parseUnits(gasUsdc, 6) > parseUnits(usdc, 6)) throw new UsageError(`--gas-usdc ${gasUsdc} is more than --usdc ${usdc}, the most this command may spend`);
    if (network.id !== "mainnet" || !network.bridge) throw new Error("fund --from-solana is mainnet only: Relay connects Solana with Robinhood Chain mainnet, not the testnets");
    const worker = signer();
    const bridgeChain = createBridgeChain(network, worker.account);
    const funding = createSolanaFunding(solanaKeypair(), network.bridge.chainId, process.env.BRAINCHAIN_SOLANA_RPC?.trim() || undefined);
    return fundFromSolana({
      funding,
      worker: worker.account.address,
      usdc,
      ...(gasUsdc ? { gasUsdc } : {}),
      stake: switches.has("stake"),
      ...(network.bridge.tokens?.stake ? { stakeToken: network.bridge.tokens.stake } : {}),
      stakeProblem: () => stakeProblem(network, bridgeChain),
      dry: switches.has("dry"),
      log: console.log,
      parentEth: () => bridgeChain.parentEth(),
      parentStake: () => bridgeChain.tokenBalance("stake"),
      bridgeOn: (asset, amount) =>
        bridge(network, bridgeChain, { asset, amount: formatUnits(amount, assetOf(network, asset).decimals), dry: false, log: console.log, sent: stakeSaver(network, worker.account.address) }),
    });
  }
  if (command === "buy-stake") {
    const given = values.get("with") ?? "eth";
    const pay = given.toLowerCase();
    if (pay !== "eth" && pay !== "usdg") throw new UsageError(`--with is eth or usdg, what buy-stake sells for the BRAIN, not "${given}"`);
    if (!network.zerox || !network.bridge) throw new UsageError(`buy-stake works on mainnet only, where BRAIN trades on Robinhood Chain; on ${network.name}, join claims the ${network.stakeSymbol} from the faucet`);
    refuseReadableKeyFile("buy-stake");
    const { account } = signer();
    const chain = createChain(network, account);
    const bridgeChain = createBridgeChain(network, account);
    const parentChainId = network.bridge.chainId;
    return buyStake(
      network,
      {
        chain: createBuyChain(network, account),
        async needs() {
          const [s, bond, held] = await Promise.all([snapshot(chain), chain.bond(), chain.stakeBalance()]);
          return { need: s.toStake + (s.applying ? bond : 0n), held, applying: s.applying };
        },
        stakeProblem: () => stakeProblem(network, bridgeChain),
        inFlight: () => stakeInFlight(network, bridgeChain, readStakeMoves(account.address, network)),
        price: (token) => relayPrice(parentChainId, token),
        quote: createQuoter(network.zerox, account),
        swapSent: (tx) => remember(network, account.address, { swap: { tx, at: Math.floor(Date.now() / 1000) } }),
        bridge: (amount) => bridge(network, bridgeChain, { asset: "stake", amount: formatUnits(amount, 18), dry: false, log: console.log, sent: stakeSaver(network, account.address) }),
      },
      { pay: pay as Pay, dry: switches.has("dry"), yes: switches.has("yes"), ...terminal(), log: console.log },
    );
  }
  if (command === "credit") {
    if (!network.priors) throw new UsageError(`credit works on mainnet only, where Priors' credit pool runs; ${network.name} has none`);
    const agentId = values.get("agent-id");
    if (agentId === undefined) throw new UsageError("credit needs --agent-id: the worker's ERC-8004 agent id, the one it declared with join --agent-id");
    if (!/^(0|[1-9]\d{0,14})$/.test(agentId)) throw new UsageError(`--agent-id is a whole number, the worker's ERC-8004 agent id, not "${agentId}"`);
    const premium = values.get("premium") ?? "0";
    if (!/^\d{1,3}$/.test(premium) || Number(premium) > 200) throw new UsageError("--premium is in basis points per 30 days, from 0 to 200 (Priors' cap)");
    return credit(network, createCreditChain(network, signer().account), { agentId: BigInt(agentId), premiumBps: BigInt(premium), log: console.log });
  }
  if (command === "exam") return examCommand(network, positional[0], values, switches);
  if (command === "licence") return licences(network, { agentId: agentIdOf(values, command), log: console.log });
  if (command === "papers") return papers(network, { agentId: agentIdOf(values, command), log: console.log });
  if (command === "watch") {
    const veto = switches.has("veto");
    const once = switches.has("once");
    if (veto && !network.contracts.gate) throw new UsageError(`${network.name} has no guardian gate yet, so there is nothing to veto through`);
    // Judging changes needs no key; vetoing and reporting do. A reader stands in for the signer otherwise.
    const keyed = veto || keyConfigured();
    const account = keyed ? signer().account : privateKeyToAccount(generatePrivateKey());
    const client = createPublicClient({ chain: chainOf(network), transport: brainchainTransport(network) });
    const { taskBoard, executor, log } = network.contracts;
    const place = watchPlace(log, keyed ? account.address : undefined);
    const verify: Verify = async (id) => {
      const report = await verifyDecision(
        {
          client,
          network: { chainId: network.chainId, name: network.name, rpc: network.rpc, sets: [] },
          set: { key: "active", release: "", fromBlock: Number(network.fromBlock), board: taskBoard, log, executor },
          briefs: new Map(),
        },
        id,
      );
      return outcome(report, keyed ? { refetch: (uri) => fetchRecord(uri) } : {});
    };
    const chain = createWatchChain(network, account);
    const watch = createWatch({
      network,
      chain,
      verify,
      ...(keyed ? { report: createReporter(network, account) } : {}),
      veto,
      log: console.log,
      ...watchResume(place, once),
    });
    if (veto) await requireWatcher(chain, console.log);
    console.log(watching(network, keyed ? account.address : undefined, veto));
    if (once) {
      const { findings, incomplete } = await watch.round();
      if (findings > 0 || incomplete) process.exitCode = 1;
      return;
    }
    for (;;) {
      await watch.round().catch((error: unknown) => console.log(`round failed: ${reason(error)}`));
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  if (command === "proposal") {
    const id = positional[0];
    if (id === undefined || !/^\d{1,18}$/.test(id) || id === "0") throw new UsageError(`Usage: ${CLI} proposal <id>, such as proposal 2`);
    // Reading a proposal needs no key, so any address stands in for the signer, and a key that is set is never read.
    return proposal(network, createProposals(network, privateKeyToAccount(generatePrivateKey())), BigInt(id), console.log);
  }
  if (command === "dispute" || command === "appeal") {
    const id = positional[0];
    if (id === undefined || !/^[1-9]\d{0,17}$/.test(id)) throw new UsageError(`Usage: ${CLI} ${command} <task>, such as ${command} 12`);
    return (command === "dispute" ? dispute : appeal)(network, createDisputeChain(network, signer().account), BigInt(id), console.log);
  }
  if (command === "propose") {
    if (!values.has("target")) throw new UsageError("--target is required: board, executor or registry");
    const worker = signer();
    const call = buildCall(network, worker.account.address, {
      target: values.get("target")!,
      call: values.get("call"),
      args: values.get("args"),
      data: values.get("data"),
    });
    const uri = caseURI(call, { title: values.get("title") ?? "", rationale: values.get("rationale") ?? "", current: values.get("current"), proposed: values.get("proposed") });
    return propose(network, createProposals(network, worker.account), call, uri, { dry: switches.has("dry"), yes: switches.has("yes"), ...terminal(), log: console.log });
  }
  if (command === "run") {
    const flags = runFlags(values);
    if (switches.has("try")) {
      if (switches.has("once") || switches.has("mint")) throw new UsageError("--try runs the command once on a sample task and delivers nothing, so it takes neither --once nor --mint");
      return rehearsal(flags);
    }
    return run(network, signer(), flags, switches.has("once"), switches.has("mint"));
  }
  if (command === "price") {
    if (positional[0] === undefined) throw new UsageError(`Usage: ${CLI} price <USDG>, such as price 0.25`);
    const asking = price(positional[0]);
    const chain = createChain(network, signer().account);
    const w = await chain.stake();
    if (!w.registered) throw new Error(`This worker has not staked yet. Run ${cli("join")}, which sets the price too.`);
    if (w.price === asking) return console.log(`The price is already ${usdg(network, asking)} per task.`);
    await needGas(chain, network);
    await chain.setPrice(asking);
    console.log(`Price set to ${usdg(network, asking)} per task.`);
    return;
  }
  const chain = createChain(network, signer().account);
  switch (command) {
    case "join":
      return join(chain, network, values);
    case "status":
      return status(chain, network);
    case "leave": {
      const w = await chain.stake();
      if (w.staked === 0n) {
        const old = (await chain.retiredStakes()).find((o) => o.w.staked > 0n);
        if (old) {
          await needGas(chain, network);
          await chain.requestUnstake(old.w.staked, old.staking);
          return console.log(`Unstaking ${stake(network, old.w.staked)} from set ${old.release}. Run ${cli("withdraw")} once its cooldown has passed and no task of the worker's on that set is in flight.`);
        }
        throw new Error(
          w.unstaking > 0n ? `Nothing left to unstake: ${stake(network, w.unstaking)} is already unstaking until ${when(w.unlocksAt)}.` : "Nothing is staked.",
        );
      }
      await needGas(chain, network);
      await chain.requestUnstake(w.staked);
      const after = await chain.stake();
      console.log(`Unstaking ${stake(network, w.staked)}. Withdraw with ${cli("withdraw")} after ${when(after.unlocksAt)}, once no task of the worker's is in flight.`);
      return;
    }
    case "withdraw": {
      const [w, held, now] = await Promise.all([chain.stake(), chain.held(), chain.now()]);
      if (w.unstaking === 0n) {
        const old = (await chain.retiredStakes()).find((o) => o.w.unstaking > 0n);
        if (!old) throw new Error(`Nothing is unstaking. Run ${cli("leave")} first.`);
        if (now < old.w.unlocksAt) throw new Error(`${stake(network, old.w.unstaking)} on set ${old.release} unlocks at ${when(old.w.unlocksAt)}. Withdraw after that.`);
        await needGas(chain, network);
        await chain.withdraw(old.staking);
        return console.log(`Withdrew ${stake(network, old.w.unstaking)} from set ${old.release}.`);
      }
      if (now < w.unlocksAt) throw new Error(`${stake(network, w.unstaking)} unlocks at ${when(w.unlocksAt)}. Withdraw after that.`);
      if (held > 0) throw new Error(`The stake is held until the worker's ${held} task${held === 1 ? "" : "s"} in flight settle.`);
      await needGas(chain, network);
      await chain.withdraw();
      console.log(`Withdrew ${stake(network, w.unstaking)}.`);
      return;
    }
  }
}
