// The licence exam for an ERC-8004 agent the worker's wallet holds: what it is
// and costs, a sitting opened for a payment over x402, each item delivered
// once, and the outcome read back, with the agent's licences and its Papers.
// The desk takes every message from the wallet that holds the agent's id, so
// the worker's key signs them, and it pays in USDG on the chain the id is on.
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createPublicClient, createWalletClient, formatUnits, keccak256, toBytes, type Address, type Hex, type PrivateKeyAccount } from "viem";

import { createChain, erc20Abi, PermanentError, reason, RECEIPT_MS, type HiredTask } from "./chain.js";
import { cli } from "./invoked.js";
import { parentChainOf, rpcTransport, type Network } from "./network.js";
import { when } from "./standing.js";
import { forgetSitting, readSittings, saveSitting, stateDir, type SavedSitting } from "./state.js";
import { deliverable, loggedTitle, MAX_RESULT_BYTES, printable, stripAnsi, taskInput, taskPrompt, type Brief, type Command } from "./work.js";

/** The canonical Permit2 contract, which an x402 payment in USDG moves through. */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** The longest a payment authorization may stay valid for the worker to sign it. */
const MAX_TIMEOUT_SECONDS = 600;
/** The headers an x402 payment travels in: version 2's, and version 1's. */
const PAYMENT_HEADERS = ["payment-signature", "x-payment"];
/** No item is started this close to the sitting's deadline: the delivery itself takes time. */
const MARGIN_SEC = 60;
/**
 * What an item is judged on, as the levels a task brief carries. The desk's briefs carry none: its rule is that
 * hidden cases decide, and work that answers one wrong is not accepted.
 */
const ITEM_LEVELS = ["Does everything the brief asks, in the form it asks for, and is right on every hidden case", "Misses what the brief asks, or is wrong on a hidden case"];

export const sittingMessage = (chainId: number, agent: { chainId: number; id: string }, sat: string, at: number): string =>
  `BrainChain exam v1\nchain ${chainId}\nagent ${agent.chainId}:${agent.id}\nclass ${sat}\nat ${at}`;

export const itemMessage = (chainId: number, sitting: string, index: number, text: string): string =>
  `BrainChain exam result v1\nchain ${chainId}\nsitting ${sitting.toLowerCase()}\nitem ${index}\nhash ${keccak256(toBytes(text))}`;

export const briefsMessage = (chainId: number, sitting: string, at: number): string => `BrainChain exam briefs v1\nchain ${chainId}\nsitting ${sitting.toLowerCase()}\nat ${at}`;

/** The chain agents' ERC-8004 ids are on: BrainChain's parent, which is the chain the Proofs live on. */
export const identityChain = (network: Network) => network.bridge ?? network.proofs;

/** What a sitting needs from the worker's key and from the chain the agent's id is on. */
export interface ExamChain {
  /** The worker's key: it signs the exam's messages and the payment. */
  wallet: Pick<PrivateKeyAccount, "address" | "signMessage" | "signTypedData">;
  /** Whether the wallet owns the agent's id or is its registered wallet; undefined when no registry could be read. */
  holdsAgent(agentId: bigint): Promise<boolean | undefined>;
  /** The wallet's USDG and ETH there, and how much of the USDG Permit2 may spend. */
  funds(): Promise<{ usdg: bigint; allowance: bigint; eth: bigint }>;
  /** Lets Permit2 spend `amount` of the wallet's USDG. */
  approve(amount: bigint): Promise<Hex>;
}

export function createExamChain(network: Network, account: PrivateKeyAccount): ExamChain {
  const parent = network.bridge;
  if (!parent) throw new Error(`${network.name} names no parent chain to pay for a sitting on`);
  const chain = parentChainOf(parent);
  const read = createPublicClient({ chain, transport: rpcTransport(parent.rpc) });
  const wallet = createWalletClient({ account, chain, transport: rpcTransport(parent.rpc) });
  const usdg = { address: network.deskUsdg.address, abi: erc20Abi } as const;
  return {
    wallet: account,
    holdsAgent: createChain(network, account).holdsAgent,
    async funds() {
      const [held, allowance, eth] = await Promise.all([
        read.readContract({ ...usdg, functionName: "balanceOf", args: [account.address] }),
        read.readContract({ ...usdg, functionName: "allowance", args: [account.address, PERMIT2] }),
        read.getBalance({ address: account.address }),
      ]);
      return { usdg: held, allowance, eth };
    },
    async approve(amount) {
      const hash = await wallet.writeContract({ ...usdg, functionName: "approve", args: [PERMIT2, amount] });
      const receipt = await read.waitForTransactionReceipt({ hash, timeout: RECEIPT_MS });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on ${parent.name}`);
      return hash;
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sameAddress = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const date = (seconds: unknown) => (typeof seconds === "number" ? when(BigInt(Math.floor(seconds))) : "an unknown time");
/** Text over several lines from the service, with nothing in it that moves the cursor or hides. */
const shown = (text: string) => stripAnsi(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const hostOf = (network: Network) => new URL(network.service).host;

/** One request to the service, and its answer as JSON: `{}` for a body that is none. */
async function ask(network: Network, path: string, fetcher: typeof fetch, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetcher(`${network.service}${path}`, { signal: AbortSignal.timeout(30_000), ...init }).catch(() => {
    throw new Error(`Could not reach the BrainChain service at ${hostOf(network)}.`);
  });
  const body: unknown = await response.json().catch(() => undefined);
  return { response, body: isObject(body) ? body : {} };
}

/** A read that must succeed: the service's JSON, `missing` for a 404, and its own words for any other refusal. */
async function read(network: Network, path: string, fetcher: typeof fetch, missing: string): Promise<Record<string, unknown>> {
  const { response, body } = await ask(network, path, fetcher);
  if (response.status === 404) throw new Error(missing);
  if (!response.ok) throw new Error(typeof body.error === "string" ? printable(body.error) : `${response.status} from the BrainChain service at ${hostOf(network)}`);
  return body;
}

const closed = (network: Network) => `The licence exam is not open on ${network.name}.`;

interface ExamInfo {
  price: string;
  classes: { class: string; about: string }[];
  rules: string[];
}

/** What GET /exams says, as lines to print; a field the service leaves out is left out. */
async function examFacts(network: Network, fetcher: typeof fetch): Promise<ExamInfo> {
  const info = await read(network, "/exams", fetcher, closed(network));
  const sitting = isObject(info.sitting) ? info.sitting : {};
  const count = (name: string) => (typeof sitting[name] === "number" ? (sitting[name] as number) : undefined);
  const [items, passMark, minutes, licenceDays, wait] = ["items", "passMark", "minutes", "licenceDays", "waitAfterFailingDays"].map(count);
  const classes = Array.isArray(info.classes) ? info.classes.flatMap((c: unknown) => (isObject(c) && typeof c.class === "string" ? [{ class: c.class, about: typeof c.about === "string" ? printable(c.about) : "" }] : [])) : [];
  return {
    price: typeof info.price === "string" ? printable(info.price) : "not stated",
    classes,
    rules: [
      ...(items !== undefined && minutes !== undefined ? [`Sitting   ${items} items in ${minutes} minutes${passMark === undefined ? "" : `; ${passMark} accepted is a pass`}`] : []),
      ...(licenceDays !== undefined ? [`Licence   lasts ${licenceDays} days${wait === undefined ? "" : `; after a failed sitting the agent waits ${wait} days before the next`}`] : []),
      ...(typeof sitting.audits === "string" ? [`Audits    ${printable(sitting.audits)}`] : []),
      ...(typeof sitting.refunds === "string" ? [`Refunds   ${printable(sitting.refunds)}`] : []),
    ],
  };
}

export async function examInfo(network: Network, options: { log: (line: string) => void; fetcher?: typeof fetch }): Promise<void> {
  const { log } = options;
  const facts = await examFacts(network, options.fetcher ?? fetch);
  log(`The licence exam on ${network.name}`);
  log(`  Price     ${facts.price}`);
  for (const c of facts.classes) log(`  Class     ${c.class}${c.about ? `: ${c.about}` : ""}`);
  for (const rule of facts.rules) log(`  ${rule}`);
  log(`Sit it with ${cli("exam sit --agent-id <id>")}: that shows the price and pays nothing until --max-price confirms it.`);
}

/**
 * What the desk asks for a sitting, read from the offer its paid route makes to a request with no payment: the
 * amount in the USDG and to the address this release pays, or undefined when the offer names neither.
 */
async function quote(network: Network, fetcher: typeof fetch): Promise<bigint | undefined> {
  const { response } = await ask(network, "/x402/exams", fetcher, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.status === 404) throw new Error(closed(network));
  let offer: unknown;
  try {
    offer = JSON.parse(Buffer.from(response.headers.get("payment-required") ?? "", "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  const accepts = isObject(offer) && Array.isArray(offer.accepts) ? offer.accepts : [];
  const ours = accepts.find(
    (a: unknown) => isObject(a) && a.network === `eip155:${identityChain(network).chainId}` && sameAddress(a.asset, network.deskUsdg.address) && sameAddress(a.payTo, network.exitDesk),
  ) as { amount?: unknown } | undefined;
  return typeof ours?.amount === "string" && /^\d{1,30}$/.test(ours.amount) ? BigInt(ours.amount) : undefined;
}

interface Opened {
  sitting: Hex;
  deadline: number;
  briefs: { index: number; title: string; brief: string }[];
  /** The items still to deliver, by index. */
  open: number[];
}

/** An open sitting with its briefs, as the desk hands it to the wallet sitting it; undefined for any other answer. */
function openedSitting(body: Record<string, unknown>): Opened | undefined {
  if (body.state !== "open" || typeof body.sitting !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.sitting) || typeof body.deadline !== "number" || !Array.isArray(body.briefs)) return undefined;
  const briefs = body.briefs.flatMap((b: unknown) => (isObject(b) && Number.isSafeInteger(b.index) && typeof b.title === "string" && typeof b.brief === "string" ? [{ index: b.index as number, title: b.title, brief: b.brief, state: b.state }] : []));
  if (briefs.length === 0) return undefined;
  return { sitting: body.sitting as Hex, deadline: body.deadline, briefs: briefs.map(({ index, title, brief }) => ({ index, title, brief })), open: briefs.filter((b) => b.state === undefined || b.state === "open").map((b) => b.index) };
}

/** A sitting's briefs again, which the desk shows to the wallet sitting it and to nobody else. */
async function briefsOf(network: Network, wallet: ExamChain["wallet"], sitting: Hex, fetcher: typeof fetch): Promise<Opened | undefined> {
  const at = Math.floor(Date.now() / 1000);
  const signature = await wallet.signMessage({ message: briefsMessage(network.chainId, sitting, at) });
  const { response, body } = await ask(network, `/exams/${sitting}/briefs?at=${at}&signature=${signature}`, fetcher);
  return response.ok ? openedSitting(body) : undefined;
}

const failure = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export interface SitOptions {
  agentId: string;
  class: string;
  /** The most the sitting may cost, in units of USDG; without it the price is shown and nothing is paid. */
  maxPrice?: bigint;
  /** The command that does each item, when the worker is to deliver them itself. */
  command?: Command;
  format: "prompt" | "json";
  timeoutMs: number;
  /** Text a delivery must never contain, such as the worker's key. */
  secrets: string[];
  dry: boolean;
  log: (line: string) => void;
  fetcher?: typeof fetch;
  /** Where sittings are kept; the worker's own folder by default. */
  dir?: string;
  /** How long a paid sitting the desk has not opened is asked for again, and how often. */
  waitMs?: number;
  everyMs?: number;
}

/**
 * Opens a sitting for an agent the wallet holds and, with a command, delivers each item. Nothing is signed for
 * a price `--max-price` does not cover. A sitting that was paid for and never answered is asked for again with
 * the same request and payment, which the desk answers from the sitting they bought and never charges twice.
 */
export async function examSit(network: Network, chain: ExamChain, options: SitOptions): Promise<void> {
  const { log, agentId, dry } = options;
  const fetcher = options.fetcher ?? fetch;
  const dir = options.dir ?? stateDir();
  const account = chain.wallet.address;
  const parent = identityChain(network);
  const { symbol } = network.deskUsdg;
  const usdg = (units: bigint) => `${formatUnits(units, 6)} ${symbol}`;
  const mine = { agentId, class: options.class };
  const again = cli(`exam sit --agent-id ${agentId}${options.class === "code" ? "" : ` --class ${options.class}`}`);
  const resend = `Run ${again} again: it sends the same request with the same payment, and nothing more is paid.`;

  const send = (request: NonNullable<SavedSitting["request"]>) =>
    fetcher(`${network.service}/x402/exams`, {
      method: "POST",
      headers: { "content-type": "application/json", [request.header[0]]: request.header[1] },
      body: request.body,
      signal: AbortSignal.timeout(120_000),
    }).catch(failure);

  /** Reads the desk's answer to a paid request and, while it is still drawing the items, sends the same request again. */
  const follow = async (request: NonNullable<SavedSitting["request"]>, at: number, first: Response | Error): Promise<Opened> => {
    const end = Date.now() + (options.waitMs ?? 180_000);
    for (let answer = first; ; answer = await send(request)) {
      if (answer instanceof Error) throw new Error(`The desk did not confirm the sitting (${reason(answer).replace(/\.$/, "")}). The payment may have gone through. ${resend}`);
      const body: unknown = await answer.json().catch(() => undefined);
      const reply = isObject(body) ? body : {};
      const opened = answer.ok ? openedSitting(reply) : undefined;
      if (opened) {
        saveSitting(account, network, { ...mine, at, sitting: opened.sitting, deadline: opened.deadline, briefs: opened.briefs }, dir);
        log(`Sitting ${opened.sitting} is open until ${date(opened.deadline)}.`);
        return opened;
      }
      // A payment answered long after it was sent can find its sitting closed: the time ran out with nothing delivered.
      if (answer.ok && typeof reply.sitting === "string" && /^0x[0-9a-fA-F]{64}$/.test(reply.sitting) && (reply.state === "passed" || reply.state === "failed")) {
        saveSitting(account, network, { ...mine, at, sitting: reply.sitting as Hex }, dir);
        throw new Error(`The sitting this payment bought, ${reply.sitting}, has closed: ${reply.state}. ${cli(`exam status --sitting ${reply.sitting}`)} shows each item's outcome.`);
      }
      const said = typeof reply.error === "string" ? printable(reply.error) : typeof reply.message === "string" ? printable(reply.message) : "";
      const aside = said ? ` (${said.replace(/\.$/, "")})` : "";
      // The desk says so itself when it refuses before it charges, and it answers 400 and 402 before it settles anything.
      if (/Nothing was charged/.test(said) || answer.status === 400 || answer.status === 402) {
        forgetSitting(account, network, mine, dir);
        throw new Error(/Nothing was charged/.test(said) ? said : `${said || `The desk answered ${answer.status}.`} Nothing was charged.`);
      }
      // 409 with the sitting named is the desk still taking the payment. Without one, the desk holds no sitting for the
      // payment and will take it no more, so keeping it would only send it again for the same answer.
      if (answer.status === 409 && typeof reply.sitting !== "string") {
        forgetSitting(account, network, mine, dir);
        throw new Error(`The desk holds no sitting for that payment and takes it no more${aside}. It is no longer kept: run ${again} again to sit.`);
      }
      if (answer.status !== 202 && answer.status !== 502 && answer.status !== 409) throw new Error(`The desk answered ${answer.status}${aside}. The payment may have gone through. ${resend}`);
      if (Date.now() >= end) throw new Error(`The sitting is paid for, and the desk has not opened it yet${aside}. ${resend}`);
      log("The sitting is paid for and the desk is still opening it; asking again...");
      await new Promise((resolve) => setTimeout(resolve, options.everyMs ?? 5_000));
    }
  };

  /** The sitting to work on: one already paid for, one still open, or a new one. Undefined when this run stops short of one. */
  const sitting = async (): Promise<Opened | undefined> => {
    const saved = readSittings(account, network, dir).find((s) => s.agentId === agentId && s.class === options.class);
    if (saved?.request) {
      log(`A sitting for agent ${agentId} was paid for at ${date(saved.at)}, and the desk had not opened it.`);
      if (dry) return void log("dry run: nothing sent. Without --dry, the same request is sent again with the same payment, and nothing more is paid.");
      log("Sending the same request with the same payment again; nothing more is paid...");
      return follow(saved.request, saved.at, await send(saved.request));
    }
    // A sitting still inside its time is gone on with: the desk opens no second one for the agent while it is.
    if (saved?.sitting && saved.deadline !== undefined && saved.deadline > Date.now() / 1000) {
      const current = await briefsOf(network, chain.wallet, saved.sitting, fetcher);
      if (current) {
        log(`Agent ${agentId} has sitting ${current.sitting} open until ${date(current.deadline)}, so this goes on with it and pays nothing.`);
        return current;
      }
    }

    const holds = await chain.holdsAgent(BigInt(agentId));
    if (holds === false) throw new Error(`${account} neither owns ERC-8004 agent ${agentId} on ${parent.name} nor is its registered wallet, so the desk would refuse the sitting. Nothing was signed or paid.`);
    if (holds === undefined && network.identity) throw new Error(`The ERC-8004 identity registry on ${parent.name} could not be read, so --agent-id was not checked. Nothing was signed or paid. Try again.`);
    const facts = await examFacts(network, fetcher);
    if (facts.classes.length > 0 && !facts.classes.some((c) => c.class === options.class)) {
      throw new Error(`The exam has no class "${options.class}". Its classes: ${facts.classes.map((c) => c.class).join(", ")}. Nothing was signed or paid.`);
    }
    const price = await quote(network, fetcher);
    if (price === undefined) {
      throw new Error(`The BrainChain service at ${hostOf(network)} offers no sitting for ${symbol} on ${parent.name} paid to ${network.exitDesk}, the only payment this release of brainchain-worker signs. Nothing was signed or paid.`);
    }
    log(`A sitting for agent ${agentId} in class ${options.class} costs ${usdg(price)} on ${parent.name}, paid by ${account} over x402.`);
    for (const rule of facts.rules) log(`  ${rule}`);
    if (holds === undefined) log(`  This release names no ERC-8004 registry on ${parent.name}, so whether ${account} holds agent ${agentId} is left to the desk, which checks before it charges.`);
    if (options.maxPrice !== undefined && price > options.maxPrice) throw new Error(`A sitting costs ${usdg(price)}, above --max-price ${formatUnits(options.maxPrice, 6)}. Nothing was signed or paid.`);
    if (options.maxPrice === undefined && !dry) return void log(`Nothing was signed or paid. To sit, run this again with --max-price ${formatUnits(price, 6)}.`);

    let funds: Awaited<ReturnType<ExamChain["funds"]>>;
    try {
      funds = await chain.funds();
    } catch (error) {
      throw new Error(`could not read the wallet on ${parent.name}: ${reason(error)}`);
    }
    const approves = funds.allowance < price;
    if (approves) log(`  Permit2, which an x402 payment in ${symbol} moves through, may spend ${usdg(funds.allowance)} of the wallet's. sit first approves ${usdg(price)} for it, which takes a little ETH on ${parent.name}.`);
    // Every shortfall at once, so a dry run says all the wallet still needs.
    const short = [
      ...(funds.usdg < price ? [`${account} holds ${usdg(funds.usdg)} on ${parent.name}, ${usdg(price - funds.usdg)} short of the sitting's price.`] : []),
      ...(approves && funds.eth === 0n ? [`${account} holds no ETH on ${parent.name} to send the approval with. ${network.bridge?.gas ?? network.proofs.gas}.`] : []),
    ];
    if (short.length > 0) throw new Error([...short, dry ? "dry run: nothing signed or sent" : "Nothing was signed or paid."].join("\n"));
    if (dry) return void log(`dry run: nothing signed or sent. Without --dry${options.maxPrice === undefined ? ` and with --max-price ${formatUnits(price, 6)}` : ""}, sit ${approves ? "approves Permit2, " : ""}signs the request, pays ${usdg(price)} and saves the sitting.`);

    if (approves) {
      log(`Approving ${usdg(price)} for Permit2 on ${parent.name}...`);
      log(`  approved: ${await chain.approve(price)}`);
    }
    const at = Math.floor(Date.now() / 1000);
    const agent = { chainId: parent.chainId, id: agentId };
    const signature = await chain.wallet.signMessage({ message: sittingMessage(network.chainId, agent, options.class, at) });
    const body = JSON.stringify({ agent, class: options.class, wallet: account, at, signature });
    const pays = `eip155:${parent.chainId}` as const;
    const client = x402Client.fromConfig({
      schemes: [{ network: pays, client: new ExactEvmScheme(chain.wallet) }],
      // The price read a moment ago is the most this payment may be, in the one token this release pays in.
      spendControls: { allowedAssets: [{ network: pays, asset: network.deskUsdg.address, maxAmountPerPayment: price.toString() }] },
      policies: [(_version, offered) => offered.filter((r) => r.network === pays && sameAddress(r.asset, network.deskUsdg.address) && sameAddress(r.payTo, network.exitDesk) && r.maxTimeoutSeconds <= MAX_TIMEOUT_SECONDS)],
    });
    let request: SavedSitting["request"];
    const paying = wrapFetchWithPayment((input, init) => {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      const name = PAYMENT_HEADERS.find((header) => headers.has(header));
      if (name) {
        // Saved before it leaves, so a payment that is sent and never answered is found by the next run.
        request = { body, header: [name, headers.get(name)!] };
        saveSitting(account, network, { ...mine, at, request }, dir);
      }
      return fetcher(input, { ...init, signal: AbortSignal.timeout(120_000) });
    }, client);
    log(`Paying ${usdg(price)} for the sitting...`);
    const answer = await paying(`${network.service}/x402/exams`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(failure);
    if (request) return follow(request, at, answer);
    // No payment left this machine: the desk refused the request as it stood, or the payment could not be signed.
    if (answer instanceof Error) throw new Error(`The payment could not be prepared: ${reason(answer).replace(/^Failed to create payment payload: /, "").replace(/\.$/, "")}. Nothing was paid.`);
    const refused: unknown = await answer.json().catch(() => undefined);
    const said = isObject(refused) && typeof refused.error === "string" ? printable(refused.error) : `The desk answered ${answer.status}.`;
    throw new Error(/Nothing was charged/.test(said) ? said : `${said} Nothing was paid.`);
  };

  const opened = await sitting();
  if (!opened) return;
  const status = cli(`exam status --sitting ${opened.sitting}`);
  const submit = (index: number) => cli(`exam submit --sitting ${opened.sitting} --item ${index} --file <path>`);
  const { command } = options;
  if (!command) {
    for (const { index, title, brief } of opened.briefs) log(`\nItem ${index}: ${printable(title)}${opened.open.includes(index) ? "" : " (delivered)"}\n${shown(brief)}`);
    log(`\nDeliver each item once, before ${date(opened.deadline)}, with ${submit(opened.open[0] ?? 0)}. An item takes one delivery.`);
    return log(`${status} shows each item's outcome.`);
  }

  const left: number[] = [];
  for (const { index, title, brief } of opened.briefs) {
    if (!opened.open.includes(index)) continue;
    const seconds = opened.deadline - Math.floor(Date.now() / 1000) - MARGIN_SEC;
    if (seconds <= 0) {
      left.push(index);
      log(`item ${index}: too close to the sitting's deadline to start`);
      continue;
    }
    log(`item ${index}: working on ${loggedTitle(title)}`);
    try {
      // The command reads an item as it reads a hired task, with the item's index as the task and the sitting's deadline as its own.
      const task: HiredTask = { id: BigInt(index), deadline: BigInt(opened.deadline), briefURI: "", briefHash: "0x" };
      const item: Brief = { title, brief, levels: ITEM_LEVELS, passIndex: 0 };
      const input = options.format === "json" ? JSON.stringify(taskInput(task, item)) : taskPrompt(task, item);
      const text = await deliverable(command, input, { env: { BRAINCHAIN_TASK_ID: String(index) }, timeoutMs: Math.min(options.timeoutMs, seconds * 1000), secrets: options.secrets });
      await deliver(network, chain.wallet, opened.sitting, index, text, fetcher);
      log(`item ${index}: delivered (${toBytes(text).byteLength} bytes)`);
    } catch (error) {
      left.push(index);
      log(`item ${index}: not delivered (${printable(reason(error)).replace(/\.$/, "")})`);
    }
  }
  log(`${status} shows each item's outcome once the desk has judged it.`);
  if (left.length === 0) return;
  process.exitCode = 1;
  log(`Not delivered: item${left.length === 1 ? "" : "s"} ${left.join(", ")}. Each can still be delivered once before ${date(opened.deadline)}, with ${submit(left[0]!)}.`);
}

/** Signs and sends the work for one item, which the desk takes once. */
async function deliver(network: Network, wallet: ExamChain["wallet"], sitting: Hex, index: number, text: string, fetcher: typeof fetch): Promise<void> {
  const signature = await wallet.signMessage({ message: itemMessage(network.chainId, sitting, index, text) });
  const status = cli(`exam status --sitting ${sitting}`);
  const response = await fetcher(`${network.service}/exams/${sitting}/items/${index}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, signature }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new Error(`Could not reach the BrainChain service at ${hostOf(network)}. The work may have arrived, and an item takes one delivery: read ${status} before sending it again`);
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return;
  const said = isObject(body) && typeof body.error === "string" ? printable(body.error) : undefined;
  // Only the service's own JSON error is a refusal: a CDN or firewall page with the same status says nothing of the item.
  if (said !== undefined) throw new PermanentError(`The service refused item ${index} (${response.status}): ${said}`);
  throw new Error(`Delivering item ${index} failed (${response.status}). The work may have arrived: read ${status} before sending it again`);
}

/** Delivers one item's work from a file or stdin, after the checks a command's output gets. */
export async function examSubmit(
  network: Network,
  wallet: ExamChain["wallet"],
  options: { sitting: Hex; item: number; text: string; secrets: string[]; log: (line: string) => void; fetcher?: typeof fetch },
): Promise<void> {
  const { text, item } = options;
  if (text.trim() === "") throw new Error("The work is empty. Nothing was sent.");
  const bytes = toBytes(text).byteLength;
  if (bytes > MAX_RESULT_BYTES) throw new Error(`The work is ${bytes} bytes; at most ${MAX_RESULT_BYTES} are accepted. Nothing was sent.`);
  const lower = text.toLowerCase();
  if (options.secrets.some((secret) => secret !== "" && lower.includes(secret.toLowerCase()))) throw new Error("The work contains the worker's private key, so it was not sent.");
  await deliver(network, wallet, options.sitting, item, text, options.fetcher ?? fetch);
  options.log(`Item ${item} delivered (${bytes} bytes). The desk judges it next: ${cli(`exam status --sitting ${options.sitting}`)} shows the outcome.`);
}

/** One item's line in a sitting's status. */
function itemLine(item: Record<string, unknown>): string {
  const cases = typeof item.right === "number" && typeof item.of === "number" ? `${item.right} of ${item.of} hidden cases right` : undefined;
  const decision = typeof item.decision === "string" ? `decision ${printable(item.decision)}` : undefined;
  const detail = [cases, decision].filter(Boolean).join(", ");
  const outcome =
    item.state === "judged"
      ? `${item.accepted === true ? "accepted" : "rejected"}${detail ? ` (${detail})` : ""}`
      : item.state === "submitted"
        ? "delivered, waiting to be judged"
        : item.state === "missed"
          ? "missed: the sitting's time ran out first"
          : item.state === "open"
            ? "open"
            : printable(String(item.state));
  return `  Item ${String(item.index)}    ${outcome}: ${typeof item.title === "string" ? printable(item.title) : ""}`;
}

/** Prints a sitting as anyone may read it: its state, each item's outcome, and on a pass when the licence expires. */
export async function examStatus(network: Network, options: { sitting?: Hex; account?: Address; log: (line: string) => void; fetcher?: typeof fetch; dir?: string }): Promise<void> {
  const { log } = options;
  const fetcher = options.fetcher ?? fetch;
  let id = options.sitting;
  if (id === undefined) {
    const latest = readSittings(options.account!, network, options.dir ?? stateDir()).sort((a, b) => b.at - a.at)[0];
    if (!latest) throw new Error(`No sitting is saved for ${options.account} on ${network.name}. Name one with --sitting <id>, or open one with ${cli("exam sit --agent-id <id>")}.`);
    if (!latest.sitting) {
      throw new Error(`The sitting for agent ${latest.agentId} was paid for at ${date(latest.at)}, and the desk had not opened it. Run ${cli(`exam sit --agent-id ${latest.agentId}`)} again: it sends the same request with the same payment, and nothing more is paid.`);
    }
    id = latest.sitting;
  }
  const view = await read(network, `/exams/${id}`, fetcher, `The BrainChain service at ${hostOf(network)} has no sitting ${id}.`);
  const items = Array.isArray(view.items) ? view.items.filter(isObject) : [];
  const agent = isObject(view.agent) && typeof view.agent.id === "string" ? ` for agent ${printable(view.agent.id)}` : "";
  const state = view.state === "open" ? `open until ${date(view.deadline)}` : view.state === "passed" || view.state === "failed" ? `${view.state}${view.closedAt === undefined ? "" : ` at ${date(view.closedAt)}`}` : printable(String(view.state));
  log(`Sitting ${id}${agent}${typeof view.class === "string" ? `, class ${printable(view.class)}` : ""}: ${state}`);
  for (const item of items) log(itemLine(item));
  const accepted = `${items.filter((item) => item.accepted === true).length} of ${items.length} accepted`;
  if (view.state === "passed") {
    const licence = isObject(view.licence) && isObject(view.licence.licence) ? view.licence.licence : {};
    return log(`Passed, with ${accepted}. The licence is valid until ${date(licence.expiresAt)}, for as long as the agent's id keeps its controller and its build.`);
  }
  if (view.state === "failed") return log(`Failed, with ${accepted}${typeof view.passMark === "number" ? `; a pass takes ${view.passMark}` : ""}. ${cli("exam info")} says how long the agent waits before the next sitting.`);
  const open = items.filter((item) => item.state === "open").map((item) => String(item.index));
  if (open.length > 0) log(`Still to deliver: item${open.length === 1 ? "" : "s"} ${open.join(", ")}, each once, with ${cli(`exam submit --sitting ${id} --item <n> --file <path>`)}.`);
  else log(`Every item is delivered or missed. The desk is judging what was delivered: run ${cli(`exam status --sitting ${id}`)} again shortly.`);
}

const STATES: Record<string, string> = {
  valid: "valid",
  expired: "expired",
  suspended: "suspended: two failed audits in the last three",
  lapsed: "lapsed: the id now has another controller or build than the licence was earned with",
};

/** A licence as one line: its class, its state and the dates and counts that go with it. */
function licenceLine(entry: Record<string, unknown>): string {
  // The licences route nests the signed licence; the Papers carry its fields flat.
  const signed = isObject(entry.licence) && isObject(entry.licence.licence) ? entry.licence.licence : entry;
  const audits = isObject(entry.audits) ? `; audits: ${String(entry.audits.passed)} passed, ${String(entry.audits.failed)} failed` : "";
  const state = typeof entry.state === "string" ? (STATES[entry.state] ?? printable(entry.state)) : "state not given";
  const earned = typeof signed.accepted === "number" && typeof signed.of === "number" ? `, earned with ${signed.accepted} of ${signed.of} accepted` : "";
  return `${printable(String(entry.class))}  ${state}; issued ${date(signed.issuedAt)}, expires ${date(signed.expiresAt)}${earned}${audits}`;
}

/** Prints an agent's licences and the state of each. Reading them needs no key. */
export async function licences(network: Network, options: { agentId: string; log: (line: string) => void; fetcher?: typeof fetch }): Promise<void> {
  const { log, agentId } = options;
  const parent = identityChain(network);
  const view = await read(network, `/licences/${parent.chainId}/${agentId}`, options.fetcher ?? fetch, closed(network));
  const held = Array.isArray(view.licences) ? view.licences.filter(isObject) : [];
  if (held.length === 0) return log(`Agent ${agentId} on ${parent.name} holds no licence. ${cli("exam info")} says what a sitting takes.`);
  log(`Licences of agent ${agentId} on ${parent.name}`);
  for (const entry of held) log(`  ${licenceLine(entry)}`);
}

/**
 * Prints where an agent's Papers are and what they say now, then the two transactions the id's owner may send
 * once, as commands to copy. Nothing is sent from here: the worker has no call to the identity registry.
 */
export async function papers(network: Network, options: { agentId: string; log: (line: string) => void; fetcher?: typeof fetch }): Promise<void> {
  const { log, agentId } = options;
  const parent = identityChain(network);
  const path = `/papers/${parent.chainId}/${agentId}`;
  const url = `${network.service}${path}`;
  const file = await read(network, path, options.fetcher ?? fetch, `The BrainChain service at ${hostOf(network)} serves no Papers for agent ${agentId} on ${parent.name}: no one controls that id, or Papers are not served on ${network.name}.`);
  const signed = isObject(file.brainchain) && isObject(file.brainchain.papers) ? file.brainchain.papers : {};
  const epoch = isObject(signed.epoch) ? signed.epoch : {};
  const record = isObject(signed.record) ? signed.record : undefined;
  const held = Array.isArray(signed.licences) ? signed.licences.filter(isObject) : [];
  const ceiling = isObject(signed.ceiling) ? signed.ceiling : undefined;
  const units = (value: unknown) => (typeof value === "string" && /^\d{1,30}$/.test(value) ? formatUnits(BigInt(value), 6) : "?");
  log(`Papers of agent ${agentId} on ${parent.name}: ${url}`);
  log(`  Epoch     ${String(epoch.number ?? "?")}${typeof epoch.since === "number" ? `, since ${date(epoch.since)}` : ""}; controller ${printable(String(epoch.controller ?? "unknown"))}; build ${typeof epoch.build === "string" && epoch.build ? JSON.stringify(printable(epoch.build)) : "none declared"}`);
  if (record) log(`  Record    ${String(record.entries)} entries: ${typeof record.url === "string" ? printable(record.url) : `${network.service}/agents/${parent.chainId}/${agentId}/record`}`);
  else log("  Record    no entry yet");
  if (held.length === 0) log("  Licences  none");
  for (const entry of held) log(`  Licence   ${licenceLine(entry)}`);
  if (ceiling) log(`  Ceiling   ${units(ceiling.units)} USD in flight at most (floor ${units(ceiling.floor)})${typeof ceiling.halvedUntil === "number" ? `, halved until ${date(ceiling.halvedUntil)}` : ""}`);
  else log("  Ceiling   not stated");
  log(`  Card      ${url}/card.svg`);
  if (typeof signed.verify === "string") log(`  Check     ${printable(signed.verify)}`);

  const registry = network.identity ?? "<identity registry>";
  const rpc = network.bridge?.rpc ?? network.proofs.rpc;
  log(
    [
      "",
      `Two transactions the id's owner can send once, on ${parent.name}. Both are optional, and this command sends neither.`,
      ...(network.identity ? [] : [`This release names no ERC-8004 registry on ${parent.name}: put the registry the id is on in place of <identity registry>.`]),
      "They are written for Foundry's cast, which asks for the key, so it never appears on the command line.",
      "",
      "  Point the id's URI at its Papers, so the record shows wherever the id's token is shown:",
      `    cast send ${registry} "setAgentURI(uint256,string)" ${agentId} "${url}" --rpc-url ${rpc} --interactive`,
      "",
      "  Declare the build the agent runs, under the id's build key: one line of printable ASCII, at most 96 characters.",
      "  A licence stands for the build declared when its sitting opened, so declare it before sitting: a change of build lapses the licence.",
      `    cast send ${registry} "setMetadata(uint256,string,bytes)" ${agentId} build "$(cast from-utf8 '<build>')" --rpc-url ${rpc} --interactive`,
    ].join("\n"),
  );
}
