import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keccak256, recoverMessageAddress, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { briefsMessage, examInfo, examSit, examStatus, examSubmit, identityChain, itemMessage, licences, MAX_WORK_BYTES, papers, PERMIT2, sittingMessage, type ExamChain, type SitOptions } from "./exam.js";
import { CLI } from "./invoked.js";
import { MAINNET, TESTNET, type Network } from "./network.js";
import { readSittings, saveSitting } from "./state.js";
import type { Command } from "./work.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const wallet = privateKeyToAccount(KEY);
const SITTING: Hex = `0x${"5a".repeat(32)}`;
// Far ahead, so a sitting in these tests is open whenever they run: 1 January 2100, and two hours after it.
const OPENED = 4_102_444_800;
const DEADLINE = OPENED + 7_200;
const PRICE = "5000000";

const LEVELS = [
  "Returns the right answer on every hidden case, with clear code that follows the rules in the brief and does not special-case inputs",
  "Returns the right answer on every hidden case",
  "Returns a wrong answer on a hidden case, defines no function of the asked name, or answers by special-casing inputs",
];
const INFO = {
  pay: `${MAINNET.service}/x402/exams`,
  price: "5.00 USD a sitting, paid over x402 in USDG on Robinhood Chain",
  classes: [{ class: "code", about: "Small Python functions, each judged on hidden cases it is run on." }],
  sitting: {
    items: 5,
    hardItems: 3,
    passMark: 4,
    levels: LEVELS,
    passes: LEVELS[1],
    barBps: 5000,
    minutes: 120,
    licenceDays: 60,
    waitAfterFailingDays: 7,
    audits: "A licensed agent's work is audited now and then with a task it cannot tell from any other. 2 failed audits in the last 3 suspend the licence.",
    refunds: "None. A sitting buys the judgments, whatever they say.",
  },
};
const RULES = [
  "  Sitting   5 items in 120 minutes, 3 of them from the hardest band; 4 accepted is a pass",
  `  Levels    ${LEVELS[0]}`,
  `            ${LEVELS[1]} (an item is accepted at this level or better)`,
  `            ${LEVELS[2]}`,
  "  Judges    work that answers every hidden case right is accepted when the judges accept it with at least 50% confidence, and work with a case wrong never is",
  "  Licence   lasts 60 days; after a failed sitting the agent waits 7 days before the next",
  "  Audits    A licensed agent's work is audited now and then with a task it cannot tell from any other. 2 failed audits in the last 3 suspend the licence.",
  "  Refunds   None. A sitting buys the judgments, whatever they say.",
];

const briefs = [0, 1, 2, 3, 4].map((index) => ({ index, title: `Item ${index}`, brief: `Write f${index}(x).\n\nReturn only the function, in one Python code block.`, state: "open" }));
const view = (extra: Record<string, unknown> = {}) => ({
  sitting: SITTING,
  agent: { chainId: 4663, registry: MAINNET.identity, id: "501" },
  class: "code",
  state: "open",
  openedAt: OPENED,
  deadline: DEADLINE,
  passMark: 4,
  items: briefs.map(({ index, title, state }) => ({ index, title, state })),
  ...extra,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const opened = () => json({ ...view(), briefs });

interface Paid {
  header: string;
  body: string;
}

/**
 * The service as the exam's routes answer: the exam's facts, the price to a request with no payment, `paid` for
 * one with a payment, and a delivery taken for each item. `refuse` is what it says of a request with no payment
 * when it will not open the sitting, given how many such requests came before. `asked` is what the request is
 * quoted the second time it comes without a payment, when that differs from the first.
 */
function service(
  network: Network,
  options: { paid?: (sent: Paid, earlier: number) => Response | Promise<Response>; refuse?: (earlier: number) => Response | undefined; asked?: string; payTo?: string; routes?: Record<string, () => Response>; info?: unknown } = {},
) {
  const seen: Paid[] = [];
  const unpaid: string[] = [];
  const delivered: { item: number; text: string; signature: Hex }[] = [];
  const read: string[] = [];
  const offer = (amount: string) =>
    Buffer.from(
      JSON.stringify({
        x402Version: 2,
        error: "Payment required",
        resource: { url: `${network.service}/x402/exams`, mimeType: "application/json" },
        accepts: [
          { scheme: "exact", network: `eip155:${identityChain(network).chainId}`, amount, asset: network.deskUsdg.address, payTo: options.payTo ?? network.exitDesk, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2" } },
        ],
      }),
    ).toString("base64");
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = req.url.replace(network.service, "");
    if (req.method === "GET") read.push(path);
    const route = options.routes?.[`${req.method} ${path.split("?")[0]}`];
    if (route) return route();
    if (path === "/exams") return json(options.info ?? INFO);
    if (path === "/x402/exams") {
      const body = await req.text();
      const header = req.headers.get("payment-signature");
      if (!header) {
        unpaid.push(body);
        return options.refuse?.(unpaid.length - 1) ?? new Response("{}", { status: 402, headers: { "payment-required": offer(unpaid.length === 1 ? PRICE : (options.asked ?? PRICE)) } });
      }
      seen.push({ header, body });
      return (options.paid ?? opened)(seen.at(-1)!, seen.length - 1);
    }
    const item = /^\/exams\/(0x[0-9a-f]{64})\/items\/(\d)$/.exec(path);
    if (item && req.method === "POST") {
      const sent = (await req.json()) as { text: string; signature: Hex };
      delivered.push({ item: Number(item[2]), ...sent });
      return json({ sitting: item[1], item: Number(item[2]), state: "submitted" }, 202);
    }
    return json({ error: "Not found." }, 404);
  }) as typeof fetch;
  return { fetcher, seen, unpaid, delivered, read };
}

/** `holds` is what the registry says of the wallet and the agent, or "unread" when it says nothing. */
function chainFor(funds = { usdg: 20_000_000n, allowance: 20_000_000n, eth: 10n ** 15n }, holds: boolean | "unread" = true) {
  return {
    wallet,
    holdsAgent: vi.fn(async () => (holds === "unread" ? undefined : holds)),
    funds: vi.fn(async () => funds),
    approve: vi.fn(async () => `0x${"a1".repeat(32)}` as Hex),
  } satisfies ExamChain;
}

function sitting(network: Network, fetcher: typeof fetch, chain: ExamChain = chainFor(), extra: Partial<SitOptions> = {}) {
  const lines: string[] = [];
  const dir = extra.dir ?? mkdtempSync(join(tmpdir(), "brainchain-exam-"));
  const run = () => examSit(network, chain, { agentId: "501", class: "code", format: "prompt", timeoutMs: 60_000, secrets: [KEY, KEY.slice(2)], dry: false, log: (line) => lines.push(line), fetcher, dir, waitMs: 200, everyMs: 5, ...extra });
  return { run, lines, dir, saved: () => readSittings(wallet.address, network, dir) };
}

afterEach(() => {
  process.exitCode = 0;
});

describe("the messages the agent's wallet signs", () => {
  it("are built as the service builds them, with the chain the id is on", () => {
    expect(sittingMessage(274663, { chainId: 4663, id: "501" }, "code", 1_800_000_000)).toBe("BrainChain exam v1\nchain 274663\nagent 4663:501\nclass code\nat 1800000000");
    const work = "```python\ndef f(x):\n    return x\n```";
    expect(itemMessage(274630, SITTING.toUpperCase().replace("0X", "0x"), 3, work)).toBe(`BrainChain exam result v1\nchain 274630\nsitting ${SITTING}\nitem 3\nhash ${keccak256(toBytes(work))}`);
    expect(briefsMessage(274663, SITTING, 1_800_000_000)).toBe(`BrainChain exam briefs v1\nchain 274663\nsitting ${SITTING}\nat 1800000000`);
    expect([identityChain(MAINNET).chainId, identityChain(TESTNET).chainId]).toEqual([4663, 46630]);
    expect([MAINNET.chainId, TESTNET.chainId]).toEqual([274663, 274630]);
  });
});

describe("exam info", () => {
  it("prints what the service says of the exam, plainly", async () => {
    const lines: string[] = [];
    await examInfo(MAINNET, { log: (line) => lines.push(line), fetcher: service(MAINNET).fetcher });
    expect(lines).toEqual([
      "The licence exam on BrainChain",
      "  Price     5.00 USD a sitting, paid over x402 in USDG on Robinhood Chain",
      "  Class     code: Small Python functions, each judged on hidden cases it is run on.",
      ...RULES,
      `Sit it with \`${CLI} exam sit --agent-id <id>\`: that shows the price and pays nothing until --max-price confirms it.`,
    ]);
  });

  it("says how sure the judges must be from the bar the service states, and nothing where it states none", async () => {
    const judges = async (sitting: Record<string, unknown>) => {
      const lines: string[] = [];
      await examInfo(MAINNET, { log: (line) => lines.push(line), fetcher: service(MAINNET, { info: { ...INFO, sitting } }).fetcher });
      return lines.find((line) => line.startsWith("  Judges"));
    };
    expect(await judges({ ...INFO.sitting, barBps: 6250 })).toContain("when the judges accept it with at least 62.5% confidence");
    const { barBps: _, ...bare } = INFO.sitting;
    expect(await judges(bare)).toBeUndefined();
  });

  it("says when the exam is not open, and passes on what the service says is wrong", async () => {
    const closed = service(TESTNET, { routes: { "GET /exams": () => json({ error: "Not found." }, 404) } });
    await expect(examInfo(TESTNET, { log: () => {}, fetcher: closed.fetcher })).rejects.toThrow(/^The licence exam is not open on BrainChain testnet\.$/);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(examInfo(TESTNET, { log: () => {}, fetcher: down })).rejects.toThrow("Could not reach the BrainChain service at brain.testnet.usebrainchain.com.");
  });
});

describe("exam sit", () => {
  it("shows the price and pays nothing until --max-price confirms it", async () => {
    const desk = service(MAINNET);
    const chain = chainFor();
    const { run, lines, saved } = sitting(MAINNET, desk.fetcher, chain);
    await run();
    expect(lines).toEqual([
      `A sitting for agent 501 in class code costs 5 USDG on Robinhood Chain, paid by ${wallet.address} over x402.`,
      ...RULES,
      "The service would open this sitting. Nothing was approved or paid: to sit, run this again with --max-price 5.",
    ]);
    // The price came with the answer to the request itself, sent once with the wallet's signature and no payment.
    expect(desk.unpaid).toHaveLength(1);
    const asked = JSON.parse(desk.unpaid[0]!) as { agent: { chainId: number; id: string }; at: number; signature: Hex };
    expect(await recoverMessageAddress({ message: sittingMessage(274663, asked.agent, "code", asked.at), signature: asked.signature })).toBe(wallet.address);
    expect(chain.holdsAgent).toHaveBeenCalledWith(501n);
    expect(chain.funds).not.toHaveBeenCalled();
    expect(chain.approve).not.toHaveBeenCalled();
    expect(desk.seen).toEqual([]);
    expect(saved()).toEqual([]);
  });

  it("refuses a price above --max-price, a class the exam does not have and an offer it does not sign, before anything is sent", async () => {
    const desk = service(MAINNET);
    const over = sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 4_999_999n });
    await expect(over.run()).rejects.toThrow(/^A sitting costs 5 USDG, above --max-price 4\.999999\. Nothing was approved or paid\.$/);
    await expect(sitting(MAINNET, desk.fetcher, chainFor(), { class: "prose", maxPrice: 5_000_000n }).run()).rejects.toThrow('The exam has no class "prose". Its classes: code. Nothing was signed or paid.');
    const elsewhere = service(MAINNET, { payTo: "0x000000000000000000000000000000000000dEaD" });
    await expect(sitting(MAINNET, elsewhere.fetcher, chainFor(), { maxPrice: 5_000_000n }).run()).rejects.toThrow(
      `The BrainChain service at brain.usebrainchain.com offers no sitting for USDG on Robinhood Chain paid to ${MAINNET.exitDesk}, the only payment this release of brainchain-worker signs. Nothing was approved or paid.`,
    );
    expect([...desk.seen, ...elsewhere.seen]).toEqual([]);
    expect(over.saved()).toEqual([]);
  });

  it("checks the wallet holds the agent before it reads a price, and leaves that to the desk where no registry is named", async () => {
    const desk = service(MAINNET);
    const stranger = sitting(MAINNET, desk.fetcher, chainFor(undefined, false), { maxPrice: 5_000_000n });
    await expect(stranger.run()).rejects.toThrow(`${wallet.address} does not hold ERC-8004 agent 501 on Robinhood Chain: it is neither its controller nor its registered wallet. The service would refuse the sitting. Nothing was signed or paid.`);
    const unread = sitting(MAINNET, desk.fetcher, chainFor(undefined, "unread"), { maxPrice: 5_000_000n });
    await expect(unread.run()).rejects.toThrow("The ERC-8004 identity registry on Robinhood Chain could not be read, so --agent-id was not checked. Nothing was signed or paid. Try again.");
    expect(desk.read).toEqual([]);
    expect(desk.unpaid).toEqual([]);

    const testnet = service(TESTNET);
    const { run, lines } = sitting(TESTNET, testnet.fetcher, chainFor(undefined, "unread"));
    await run();
    expect(lines[0]).toBe(`A sitting for agent 501 in class code costs 5 test USDG on Robinhood Chain testnet, paid by ${wallet.address} over x402.`);
    expect(lines).toContain(`  This release names no ERC-8004 registry on Robinhood Chain testnet, so whether ${wallet.address} holds agent 501 is left to the service, which checks before it charges.`);
  });

  it("says with --dry all the wallet still needs, or what it would do, and signs nothing", async () => {
    const desk = service(MAINNET);
    const empty = sitting(MAINNET, desk.fetcher, chainFor({ usdg: 1_250_000n, allowance: 0n, eth: 0n }), { dry: true });
    await expect(empty.run()).rejects.toThrow(
      [
        `${wallet.address} holds 1.25 USDG on Robinhood Chain, 3.75 USDG short of the sitting's price.`,
        `${wallet.address} holds no ETH on Robinhood Chain to send the approval with. Send it a little ETH on Robinhood Chain.`,
        "dry run: nothing approved or paid",
      ].join("\n"),
    );
    const unapproved = chainFor({ usdg: 5_000_000n, allowance: 1_000_000n, eth: 10n ** 15n });
    const ready = sitting(MAINNET, desk.fetcher, unapproved, { dry: true, maxPrice: 6_000_000n });
    await ready.run();
    expect(ready.lines.slice(-2)).toEqual([
      "  Permit2, which an x402 payment in USDG moves through, may spend 1 USDG of the wallet's. sit first approves 5 USDG for it, which takes a little ETH on Robinhood Chain.",
      "dry run: nothing approved or paid. Without --dry, sit approves Permit2, pays 5 USDG and saves the sitting.",
    ]);
    const unconfirmed = sitting(MAINNET, desk.fetcher, chainFor(), { dry: true });
    await unconfirmed.run();
    expect(unconfirmed.lines.at(-1)).toBe("dry run: nothing approved or paid. Without --dry and with --max-price 5, sit pays 5 USDG and saves the sitting.");
    expect(unapproved.approve).not.toHaveBeenCalled();
    expect(desk.seen).toEqual([]);
    expect([...empty.saved(), ...ready.saved()]).toEqual([]);
  });

  it("approves Permit2 for the price when it must, signs the request, pays the desk that price and keeps the sitting", async () => {
    const desk = service(MAINNET);
    const chain = chainFor({ usdg: 5_000_000n, allowance: 0n, eth: 10n ** 15n });
    const { run, lines, saved } = sitting(MAINNET, desk.fetcher, chain, { maxPrice: 5_000_000n });
    await run();
    expect(chain.approve).toHaveBeenCalledExactlyOnceWith(5_000_000n);
    expect(desk.seen).toHaveLength(1);
    // The request went once with no payment, to be refused or quoted, and then again to be paid.
    expect(desk.unpaid).toEqual([desk.seen[0]!.body, desk.seen[0]!.body]);
    const sent = JSON.parse(desk.seen[0]!.body) as { agent: { chainId: number; id: string }; class: string; wallet: string; at: number; signature: Hex };
    expect(sent).toMatchObject({ agent: { chainId: 4663, id: "501" }, class: "code", wallet: wallet.address });
    expect(await recoverMessageAddress({ message: sittingMessage(274663, sent.agent, "code", sent.at), signature: sent.signature })).toBe(wallet.address);
    const payment = JSON.parse(Buffer.from(desk.seen[0]!.header, "base64").toString("utf8")) as { accepted: Record<string, string>; payload: { permit2Authorization: { from: string } } };
    expect(payment.accepted).toMatchObject({ network: "eip155:4663", amount: PRICE, asset: MAINNET.deskUsdg.address, payTo: MAINNET.exitDesk });
    expect(payment.payload.permit2Authorization.from).toBe(wallet.address);
    expect(saved()).toEqual([{ agentId: "501", class: "code", at: sent.at, sitting: SITTING, deadline: DEADLINE }]);

    expect(lines.slice(1 + RULES.length, 6 + RULES.length)).toEqual([
      "  Permit2, which an x402 payment in USDG moves through, may spend 0 USDG of the wallet's. sit first approves 5 USDG for it, which takes a little ETH on Robinhood Chain.",
      "Approving 5 USDG for Permit2 on Robinhood Chain...",
      `  approved: 0x${"a1".repeat(32)}`,
      "Paying 5 USDG for the sitting...",
      `Sitting ${SITTING} is open until 2100-01-01T02:00:00Z.`,
    ]);
    expect(lines[6 + RULES.length]).toBe("\nItem 0: Item 0\nWrite f0(x).\n\nReturn only the function, in one Python code block.");
    expect(lines.slice(-2)).toEqual([
      `\nDeliver each item once, before 2100-01-01T02:00:00Z, with \`${CLI} exam submit --sitting ${SITTING} --item 0 --file <path>\`. An item takes one delivery.`,
      `\`${CLI} exam status --sitting ${SITTING}\` shows each item's outcome.`,
    ]);
  });

  it("signs for the price it read and no more", async () => {
    const desk = service(MAINNET, { asked: "5000001" });
    const { run, saved } = sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 9_000_000n });
    await expect(run()).rejects.toThrow(/^The payment could not be prepared: .*\. Nothing was paid\.$/);
    expect(desk.seen).toEqual([]);
    expect(saved()).toEqual([]);
  });

  it("hears the service's refusal on the first request, before it reads the wallet, approves or pays anything", async () => {
    for (const [status, error] of [
      [403, `Wallet ${wallet.address} does not hold agent 501: it is neither its controller nor its registered wallet. Nothing was charged.`],
      [409, "Agent 501 holds a code licence until 2100-03-02 00:00 UTC. It may sit again from 2100-02-16 00:00 UTC. Nothing was charged."],
      [409, "Agent 501 failed a code sitting on 2099-12-30 00:00 UTC and may sit again from 2100-01-06 00:00 UTC. Nothing was charged."],
      [503, "The agent's identity could not be read just now. Nothing was charged; try again."],
    ] as const) {
      const desk = service(MAINNET, { refuse: () => json({ error }, status) });
      const chain = chainFor({ usdg: 5_000_000n, allowance: 0n, eth: 10n ** 15n });
      const { run, lines, saved } = sitting(MAINNET, desk.fetcher, chain, { maxPrice: 5_000_000n });
      expect(await run().catch((e: Error) => e.message)).toBe(error);
      expect(desk.unpaid).toHaveLength(1);
      expect(desk.seen).toEqual([]);
      for (const call of [chain.funds, chain.approve]) expect(call).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
      expect(saved()).toEqual([]);
    }
  });

  it("keeps a sitting the service says is already paid for and opening, in place of paying for a second", async () => {
    const other: Hex = `0x${"0d".repeat(32)}`;
    const refusal = () => json({ error: "A sitting for agent 501 is already paid for and being opened. Send the request that paid for it again to read it. Nothing was charged.", sitting: other }, 409);
    const told = (nothing: string) =>
      `A sitting for agent 501 is already paid for, and the service is opening it: ${MAINNET.service}/exams/${other}. Through the paid route only the request that paid for it reads its briefs, and that request is not kept here. ` +
      `Once the sitting is open, \`${CLI} exam sit --agent-id 501\` reads the briefs with this wallet's signature and goes on with it. ${nothing}`;
    // Until the sitting is open its briefs address answers 409 with where it stands.
    const drawing = "The sitting is paid for and its items are being drawn. Send the request that paid for it again to read it; it is not charged twice.";
    let open = false;
    const routes = { [`GET /exams/${other}/briefs`]: () => (open ? json({ ...view({ sitting: other }), briefs }) : json({ error: drawing, sitting: other, state: "opening", payment: "paid", message: drawing }, 409)) };
    // Told on the first request, as a worker whose folder was lost is.
    const desk = service(MAINNET, { refuse: refusal, routes });
    const chain = chainFor({ usdg: 5_000_000n, allowance: 0n, eth: 10n ** 15n });
    const first = sitting(MAINNET, desk.fetcher, chain, { maxPrice: 5_000_000n });
    await expect(first.run()).rejects.toThrow(told("Nothing was charged."));
    expect(desk.seen).toEqual([]);
    for (const call of [chain.funds, chain.approve]) expect(call).not.toHaveBeenCalled();
    expect(first.saved()).toEqual([{ agentId: "501", class: "code", at: expect.any(Number), sitting: other }]);
    // While it is still opening, the same command says so from the sitting it kept, and sends no request for a new one.
    await expect(sitting(MAINNET, desk.fetcher, chain, { dir: first.dir, maxPrice: 5_000_000n }).run()).rejects.toThrow(told("Nothing was approved or paid."));
    expect(desk.unpaid).toHaveLength(1);
    // Once it is open, the same command reads its briefs with the wallet's signature and goes on with it.
    open = true;
    const second = sitting(MAINNET, desk.fetcher, chain, { dir: first.dir });
    await second.run();
    expect(second.lines[0]).toBe(`Agent 501 has sitting ${other} open until 2100-01-01T02:00:00Z, so this goes on with it and pays nothing.`);
    expect(desk.unpaid).toHaveLength(1);

    // Or told with the payment, when another payment for the agent arrived after the offer: this one is not kept.
    open = false;
    const late = service(MAINNET, { paid: refusal, routes });
    const paying = sitting(MAINNET, late.fetcher, chainFor(), { maxPrice: 5_000_000n });
    await expect(paying.run()).rejects.toThrow(told("Nothing was charged."));
    expect(late.seen).toHaveLength(1);
    expect(paying.saved()).toEqual([{ agentId: "501", class: "code", at: expect.any(Number), sitting: other }]);

    // A payment still being settled reads as that.
    const settling = service(MAINNET, { refuse: refusal, routes: { [`GET /exams/${other}/briefs`]: () => json({ error: "The payment for this sitting is being settled.", sitting: other, state: "paying", payment: "unconfirmed" }, 409) } });
    await expect(sitting(MAINNET, settling.fetcher, chainFor(), { maxPrice: 5_000_000n }).run()).rejects.toThrow(`A sitting for agent 501 is already being paid for, and the service is settling its payment: ${MAINNET.service}/exams/${other}.`);
  });

  it("goes on with a sitting the service says is open, when its briefs can be read with this wallet's signature", async () => {
    const error = `Agent 501 has a sitting open until 2100-01-01 02:00 UTC: ${MAINNET.service}/exams/${SITTING}. Nothing was charged.`;
    const refusal = () => json({ error, sitting: SITTING }, 409);
    const desk = service(MAINNET, { refuse: refusal, routes: { [`GET /exams/${SITTING}/briefs`]: () => json({ ...view(), briefs }) } });
    const { run, lines, saved } = sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 5_000_000n });
    await run();
    expect(lines[0]).toBe(`Agent 501 has sitting ${SITTING} open until 2100-01-01T02:00:00Z, so this goes on with it and pays nothing.`);
    expect(saved()).toEqual([expect.objectContaining({ sitting: SITTING, deadline: DEADLINE })]);
    expect(desk.seen).toEqual([]);
    // Another wallet's sitting for the same agent cannot be read, so the service's words stand as they are.
    const theirs = service(MAINNET, { refuse: refusal, routes: { [`GET /exams/${SITTING}/briefs`]: () => json({ error: "The signature is not the sitting wallet's signature of the briefs message." }, 403) } });
    const stranger = sitting(MAINNET, theirs.fetcher, chainFor(), { maxPrice: 5_000_000n });
    expect(await stranger.run().catch((e: Error) => e.message)).toBe(error);
    expect(stranger.saved()).toEqual([]);
    // The sitting is taken from the field the service names it in, never read out of its sentence.
    const unnamed = service(MAINNET, { refuse: () => json({ error }, 409), routes: { [`GET /exams/${SITTING}/briefs`]: () => json({ ...view(), briefs }) } });
    expect(await sitting(MAINNET, unnamed.fetcher, chainFor(), { maxPrice: 5_000_000n }).run().catch((e: Error) => e.message)).toBe(error);
    expect(unnamed.read.filter((path) => path.includes("/briefs"))).toEqual([]);
  });

  it("says to run it again in a minute when the service has had too many unpaid requests from this address", async () => {
    const limited = () => json({ error: "Too many requests from this address. Nothing was charged; try again in a minute." }, 429, { "retry-after": "60" });
    const desk = service(MAINNET, { refuse: limited });
    const chain = chainFor({ usdg: 5_000_000n, allowance: 0n, eth: 10n ** 15n });
    const { run, saved } = sitting(MAINNET, desk.fetcher, chain, { maxPrice: 5_000_000n });
    await expect(run()).rejects.toThrow(
      `The service has had too many sitting requests from this address in the last minute, so it did not look at this one. Nothing was approved or paid. Run \`${CLI} exam sit --agent-id 501\` again in a minute.`,
    );
    for (const call of [chain.funds, chain.approve]) expect(call).not.toHaveBeenCalled();
    expect(desk.seen).toEqual([]);
    expect(saved()).toEqual([]);
    // Turned away again once the price was read and the approval sent: the allowance stays, and nothing was paid.
    const later = service(MAINNET, { refuse: (earlier) => (earlier === 0 ? undefined : limited()) });
    await expect(sitting(MAINNET, later.fetcher, chainFor(), { maxPrice: 5_000_000n }).run()).rejects.toThrow(/so it did not look at this one\. Nothing was paid\. Run /);
    expect(later.seen).toEqual([]);
  });

  it("passes on a refusal that comes with the payment, when something changed after the offer, in the service's words, and keeps nothing of it", async () => {
    for (const [status, error] of [
      [403, `Wallet ${wallet.address} does not hold agent 501: it is neither its controller nor its registered wallet. Nothing was charged.`],
      [409, "Agent 501 holds a code licence until 2100-03-02 00:00 UTC. It may sit again from 2100-02-16 00:00 UTC. Nothing was charged."],
      [503, "The agent's identity could not be read just now. Nothing was charged; try again."],
    ] as const) {
      const desk = service(MAINNET, { paid: () => json({ error }, status) });
      const { run, saved } = sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 5_000_000n });
      expect(await run().catch((e: Error) => e.message)).toBe(error);
      expect(desk.seen).toHaveLength(1);
      expect(saved()).toEqual([]);
    }
    const unreadable = service(MAINNET, { paid: () => json({ error: "agent.id is the agent's ERC-8004 id, as a decimal string." }, 400) });
    await expect(sitting(MAINNET, unreadable.fetcher, chainFor(), { maxPrice: 5_000_000n }).run()).rejects.toThrow(/^agent\.id is the agent's ERC-8004 id, as a decimal string\. Nothing was charged\.$/);
  });

  it("sends the same request with the same payment again while the desk draws the items", async () => {
    const drawing = { message: "The sitting is paid for and its items are being drawn. Send the same request again to read them; it is not charged twice.", sitting: SITTING, state: "paid" };
    const desk = service(MAINNET, { paid: (_sent, earlier) => (earlier < 2 ? json(drawing, 202) : opened()) });
    const { run, lines, saved } = sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 5_000_000n });
    await run();
    expect(desk.seen).toHaveLength(3);
    expect(new Set(desk.seen.map((sent) => `${sent.header} ${sent.body}`)).size).toBe(1);
    expect(lines.filter((line) => line === "The sitting is paid for and the desk is still opening it; asking again...")).toHaveLength(2);
    expect(saved()[0]).toMatchObject({ sitting: SITTING });
    expect(saved()[0]).not.toHaveProperty("request");
  });

  it("keeps a payment the desk has not answered with a sitting, and the next run sends it again and pays nothing more", async () => {
    for (const first of [
      () => json({ error: "The sitting is paid for, but its items could not be drawn just now. It is retried until it opens; send the same request again to read it.", sitting: SITTING, state: "paid" }, 502),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      let open = false;
      const desk = service(MAINNET, { paid: () => (open ? opened() : first()) });
      const paying = chainFor({ usdg: 5_000_000n, allowance: 0n, eth: 10n ** 15n });
      const { run, saved, dir } = sitting(MAINNET, desk.fetcher, paying, { maxPrice: 5_000_000n, waitMs: 20 });
      const said = await run().catch((e: Error) => e.message);
      expect(said).toMatch(/^(The sitting is paid for, and the desk has not opened it yet \(The sitting is paid for, but its items could not be drawn just now.*\)|The desk did not confirm the sitting \(fetch failed\)\. The payment may have gone through)\./);
      expect(said).toContain(`Run \`${CLI} exam sit --agent-id 501\` again: it sends the same request with the same payment, and nothing more is paid.`);
      const { header, body } = desk.seen[0]!;
      // The payment is kept as it was sent, with the sitting's id once the service has named it, so status can read it.
      const kept = { agentId: "501", class: "code", at: (JSON.parse(body) as { at: number }).at, request: { body, header: ["payment-signature", header] } };
      expect(saved()).toEqual([said!.startsWith("The sitting is paid for") ? { ...kept, sitting: SITTING } : kept]);

      // The next run needs no --max-price: nothing new is signed, checked or approved.
      open = true;
      const asked = desk.seen.length;
      const probes = desk.unpaid.length;
      const idle = chainFor();
      const again = sitting(MAINNET, desk.fetcher, idle, { dir });
      await again.run();
      expect(desk.seen).toHaveLength(asked + 1);
      expect(desk.seen.at(-1)).toEqual({ header, body });
      expect(desk.unpaid).toHaveLength(probes);
      for (const call of [idle.holdsAgent, idle.funds, idle.approve]) expect(call).not.toHaveBeenCalled();
      expect(again.lines.slice(0, 2)).toEqual([expect.stringMatching(/^A sitting for agent 501 was paid for at \d{4}-.*Z, and the desk had not opened it\.$/), "Sending the same request with the same payment again; nothing more is paid..."]);
      expect(again.saved()).toEqual([expect.objectContaining({ sitting: SITTING, deadline: DEADLINE })]);
      expect(again.saved()[0]).not.toHaveProperty("request");
    }
  });

  it("forgets a kept payment the desk turns out never to have taken", async () => {
    let down = true;
    const desk = service(MAINNET, {
      paid: () => {
        if (down) throw new TypeError("fetch failed");
        return json({ error: "The payment's deadline has passed." }, 402);
      },
    });
    const { run, saved, dir } = sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 5_000_000n });
    await run().catch(() => undefined);
    expect(saved()).toHaveLength(1);
    down = false;
    await expect(sitting(MAINNET, desk.fetcher, chainFor(), { dir }).run()).rejects.toThrow(/^The payment's deadline has passed\. Nothing was charged\.$/);
    expect(saved()).toEqual([]);
  });

  it("stops keeping a payment whose sitting has closed, or that the desk takes no more", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainchain-exam-"));
    const kept = { agentId: "501", class: "code", at: OPENED, request: { body: "{}", header: ["payment-signature", "abc"] as [string, string] } };
    saveSitting(wallet.address, MAINNET, kept, dir);
    const closed = service(MAINNET, { paid: () => json({ ...view({ state: "failed", closedAt: DEADLINE }), briefs }) });
    await expect(sitting(MAINNET, closed.fetcher, chainFor(), { dir }).run()).rejects.toThrow(`The sitting this payment bought, ${SITTING}, has closed: failed. \`${CLI} exam status --sitting ${SITTING}\` shows each item's outcome.`);
    expect(readSittings(wallet.address, MAINNET, dir)).toEqual([{ agentId: "501", class: "code", at: OPENED, sitting: SITTING }]);

    saveSitting(wallet.address, MAINNET, kept, dir);
    const used = service(MAINNET, { paid: () => json({ error: "This payment was already used. Sign a new one." }, 409) });
    await expect(sitting(MAINNET, used.fetcher, chainFor(), { dir }).run()).rejects.toThrow(
      `The desk holds no sitting for that payment and takes it no more (This payment was already used. Sign a new one). It is no longer kept: run \`${CLI} exam sit --agent-id 501\` again to sit.`,
    );
    expect(readSittings(wallet.address, MAINNET, dir)).toEqual([]);
  });

  it("moves a damaged saved sitting aside and says so, never writing over it", async () => {
    const desk = service(MAINNET);
    const dir = mkdtempSync(join(tmpdir(), "brainchain-exam-"));
    const file = join(dir, `${wallet.address}.mainnet.exam.501.code.json`);
    writeFileSync(file, '{"agentId":"501","class":"code","at":');
    const { run, lines } = sitting(MAINNET, desk.fetcher, chainFor(), { dir });
    await run();
    const aside = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    expect(aside).toHaveLength(1);
    expect(lines[0]).toBe(`warning: ${file} could not be read as a saved sitting, so it was moved to ${join(dir, aside[0]!)}`);
    expect(desk.unpaid).toHaveLength(1);
  });

  it("only says what it would send for a kept payment under --dry", async () => {
    const desk = service(MAINNET);
    const dir = mkdtempSync(join(tmpdir(), "brainchain-exam-"));
    saveSitting(wallet.address, MAINNET, { agentId: "501", class: "code", at: OPENED, request: { body: "{}", header: ["payment-signature", "abc"] } }, dir);
    const { run, lines } = sitting(MAINNET, desk.fetcher, chainFor(), { dir, dry: true });
    await run();
    expect(lines).toEqual([
      "A sitting for agent 501 was paid for at 2100-01-01T00:00:00Z, and the desk had not opened it.",
      "dry run: nothing sent. Without --dry, the same request is sent again with the same payment, and nothing more is paid.",
    ]);
    expect(desk.seen).toEqual([]);
  });

  it("runs the command once on each item, with the item on stdin as a task is, and delivers what it prints", async () => {
    const desk = service(MAINNET);
    const inputs: { input: string; env: Record<string, string>; timeoutMs: number }[] = [];
    const command: Command = {
      run: async (input, env, timeoutMs) => {
        inputs.push({ input, env, timeoutMs });
        if (env.BRAINCHAIN_TASK_ID === "3") throw new Error("The command exited with code 1");
        return `\n\`\`\`python\ndef f${env.BRAINCHAIN_TASK_ID}(x):\n    return x\n\`\`\`\n`;
      },
      kill: () => undefined,
    };
    const { run, lines } = sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 5_000_000n, command, timeoutMs: 90_000 });
    await run();
    expect(inputs.map(({ env }) => env)).toEqual([0, 1, 2, 3, 4].map((index) => ({ BRAINCHAIN_TASK_ID: String(index) })));
    expect(inputs.every(({ timeoutMs }) => timeoutMs === 90_000)).toBe(true);
    // The prompt a hired task gets, around this item.
    expect(inputs[0]!.input).toMatch(/^You are a worker on BrainChain\. Complete the task below and reply with only the deliverable\./);
    expect(inputs[0]!.input).toContain('"title": "Item 0"');
    expect(inputs[0]!.input).toContain("Return only the function, in one Python code block.");
    // The levels are the ones the service grades an item against, and the level it must reach.
    expect(inputs[0]!.input).toContain(`"passLevel": "${LEVELS[1]}"`);
    for (const level of LEVELS) expect(inputs[0]!.input).toContain(level);

    expect(desk.delivered.map(({ item }) => item)).toEqual([0, 1, 2, 4]);
    for (const { item, text, signature } of desk.delivered) {
      expect(text).toBe(`\`\`\`python\ndef f${item}(x):\n    return x\n\`\`\``);
      expect(await recoverMessageAddress({ message: itemMessage(274663, SITTING, item, text), signature })).toBe(wallet.address);
    }
    expect(lines).toContain('item 0: working on "Item 0"');
    expect(lines).toContain("item 0: delivered (37 bytes)");
    expect(lines).toContain("item 3: not delivered (The command exited with code 1)");
    expect(lines.at(-1)).toBe(`Not delivered: item 3. Each can still be delivered once before 2100-01-01T02:00:00Z, with \`${CLI} exam submit --sitting ${SITTING} --item 3 --file <path>\`.`);
    expect(process.exitCode).toBe(1);
    expect(lines.join("\n")).not.toContain("Write f0(x).");
  });

  it("gives the command the item as JSON with --format json, and keeps a key in its output off the wire", async () => {
    const desk = service(MAINNET);
    const inputs: string[] = [];
    const command: Command = {
      run: async (input, env) => {
        inputs.push(input);
        if (env.BRAINCHAIN_TASK_ID === "3") return "#".repeat(MAX_WORK_BYTES + 1);
        return env.BRAINCHAIN_TASK_ID === "1" ? `key = "${KEY}"` : "def f(x): return x";
      },
      kill: () => undefined,
    };
    const { run, lines } = sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 5_000_000n, command, format: "json" });
    await run();
    expect(JSON.parse(inputs[2]!)).toEqual({
      task: "2",
      title: "Item 2",
      brief: briefs[2]!.brief,
      levels: LEVELS,
      passLevel: LEVELS[1],
      deadline: "2100-01-01T02:00:00.000Z",
    });
    expect(desk.delivered.map(({ item }) => item)).toEqual([0, 2, 4]);
    expect(lines).toContain("item 1: not delivered (The result contains the worker's private key, so it was not uploaded. Check what the command can read)");
    // An item takes less than a task's result does, and what is over is never sent.
    expect(lines).toContain("item 3: not delivered (The work is 48001 bytes; at most 48000 are accepted for an item. Nothing was sent)");
    expect(JSON.stringify(desk.delivered)).not.toContain(KEY.slice(2));
  });

  it("refuses --exec before anything is signed when the service states no levels to give the command", async () => {
    const { levels: _, ...bare } = INFO.sitting;
    const desk = service(MAINNET, { info: { ...INFO, sitting: bare } });
    const command: Command = { run: async () => "def f(x): return x", kill: () => undefined };
    await expect(sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 5_000_000n, command }).run()).rejects.toThrow(
      `The service states no levels for an item, and --exec gives the command each item with them. Nothing was signed or paid. Without --exec, sit prints the briefs, and \`${CLI} exam submit\` delivers each item.`,
    );
    expect(desk.unpaid).toEqual([]);
  });

  it("goes on with a sitting that is still open, on the items still to deliver, and pays nothing", async () => {
    const left = briefs.map((b) => (b.index < 3 ? { ...b, state: "judged" } : b));
    const desk = service(MAINNET, { routes: { [`GET /exams/${SITTING}/briefs`]: () => json({ ...view(), briefs: left }) } });
    const dir = mkdtempSync(join(tmpdir(), "brainchain-exam-"));
    saveSitting(wallet.address, MAINNET, { agentId: "501", class: "code", at: OPENED, sitting: SITTING, deadline: DEADLINE }, dir);
    const ran: string[] = [];
    const command: Command = { run: async (_input, env) => (ran.push(env.BRAINCHAIN_TASK_ID!), "def f(x): return x"), kill: () => undefined };
    const chain = chainFor();
    const { run, lines } = sitting(MAINNET, desk.fetcher, chain, { dir, command });
    await run();
    expect(lines[0]).toBe(`Agent 501 has sitting ${SITTING} open until 2100-01-01T02:00:00Z, so this goes on with it and pays nothing.`);
    expect(ran).toEqual(["3", "4"]);
    expect(desk.delivered.map(({ item }) => item)).toEqual([3, 4]);
    expect(desk.seen).toEqual([]);
    expect(chain.funds).not.toHaveBeenCalled();
    // The briefs are shown to the wallet sitting it, so the request for them is signed.
    const asked = new URL(`${MAINNET.service}${desk.read.find((path) => path.includes("/briefs"))}`);
    const at = Number(asked.searchParams.get("at"));
    expect(await recoverMessageAddress({ message: briefsMessage(274663, SITTING, at), signature: asked.searchParams.get("signature") as Hex })).toBe(wallet.address);
  });
});

describe("exam submit", () => {
  const work = "```python\ndef f2(x):\n    return x\n```\n";

  it("signs one item's work as it is and delivers it", async () => {
    const desk = service(TESTNET);
    const lines: string[] = [];
    await examSubmit(TESTNET, wallet, { sitting: SITTING, item: 2, text: work, secrets: [KEY], log: (line) => lines.push(line), fetcher: desk.fetcher });
    expect(desk.delivered).toHaveLength(1);
    expect(desk.delivered[0]).toMatchObject({ item: 2, text: work });
    expect(await recoverMessageAddress({ message: itemMessage(274630, SITTING, 2, work), signature: desk.delivered[0]!.signature })).toBe(wallet.address);
    expect(lines).toEqual([`Item 2 delivered (38 bytes). The desk judges it next: \`${CLI} exam status --sitting ${SITTING}\` shows the outcome.`]);
  });

  it("refuses work that is empty, too large or holds the key, before anything is sent", async () => {
    const desk = service(TESTNET);
    const send = (text: string) => examSubmit(TESTNET, wallet, { sitting: SITTING, item: 0, text, secrets: [KEY, KEY.slice(2)], log: () => {}, fetcher: desk.fetcher });
    await expect(send(" \n")).rejects.toThrow("The work is empty. Nothing was sent.");
    await expect(send("é".repeat(MAX_WORK_BYTES / 2 + 1))).rejects.toThrow("The work is 48002 bytes; at most 48000 are accepted for an item. Nothing was sent");
    await expect(send(`secret = "${KEY.slice(2).toUpperCase()}"`)).rejects.toThrow("The work contains the worker's private key, so it was not sent.");
    expect(desk.delivered).toEqual([]);
  });

  it("passes on why the service did not take it, and says a delivery it could not confirm may have arrived", async () => {
    const taken = service(TESTNET, { routes: { [`POST /exams/${SITTING}/items/0`]: () => json({ error: "This item was already delivered. An item takes one delivery." }, 409) } });
    const send = (fetcher: typeof fetch) => examSubmit(TESTNET, wallet, { sitting: SITTING, item: 0, text: work, secrets: [], log: () => {}, fetcher });
    await expect(send(taken.fetcher)).rejects.toThrow("The service refused item 0 (409): This item was already delivered. An item takes one delivery.");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(send(down)).rejects.toThrow(
      `Could not reach the BrainChain service at brain.testnet.usebrainchain.com. The work may have arrived, and an item takes one delivery: read \`${CLI} exam status --sitting ${SITTING}\` before sending it again`,
    );
    const proxy = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    await expect(send(proxy)).rejects.toThrow(`Delivering item 0 failed (502). The work may have arrived: read \`${CLI} exam status --sitting ${SITTING}\` before sending it again`);
  });
});

describe("exam status", () => {
  const judged = (accepted: number) => view().items.map((item, i) => ({ ...item, state: "judged", accepted: i < accepted, right: i < accepted ? 12 : 11, of: 12, decision: String(4800 + i) }));
  const status = async (network: Network, body: unknown, options: { sitting?: Hex; dir?: string } = { sitting: SITTING }) => {
    const lines: string[] = [];
    const desk = service(network, { routes: { [`GET /exams/${SITTING}`]: () => json(body) } });
    await examStatus(network, { ...options, account: wallet.address, log: (line) => lines.push(line), fetcher: desk.fetcher });
    return lines;
  };

  it("prints an open sitting, each item's state and what is still to deliver", async () => {
    const items = view().items.map((item, i) => (i === 0 ? { ...item, state: "judged", accepted: true, right: 12, of: 12, judges: "accept", confidenceBps: 9100, decision: "4801" } : i === 1 ? { ...item, state: "submitted" } : i === 2 ? { ...item, state: "missed" } : item));
    expect(await status(MAINNET, view({ items }))).toEqual([
      `Sitting ${SITTING} for agent 501, class code: open until 2100-01-01T02:00:00Z`,
      "  Item 0    accepted (12 of 12 hidden cases right, judges accepted at 91%, decision 4801): Item 0",
      "  Item 1    delivered, waiting to be judged: Item 1",
      "  Item 2    missed: the sitting's time ran out first: Item 2",
      "  Item 3    open: Item 3",
      "  Item 4    open: Item 4",
      `Still to deliver: items 3, 4, each once, with \`${CLI} exam submit --sitting ${SITTING} --item <n> --file <path>\`.`,
    ]);
  });

  it("says how a sitting ended, with when the licence expires on a pass", async () => {
    const licence = { licence: { class: "code", issuedAt: DEADLINE, expiresAt: DEADLINE + 60 * 86_400 }, signature: "0x01" };
    const passed = await status(MAINNET, view({ state: "passed", closedAt: DEADLINE, items: judged(4), licence }));
    expect(passed[0]).toBe(`Sitting ${SITTING} for agent 501, class code: passed at 2100-01-01T02:00:00Z`);
    // An item judged before the judges' confidence was kept has none to show.
    expect(passed[5]).toBe("  Item 4    rejected (11 of 12 hidden cases right, decision 4804): Item 4");
    // An item refused with every hidden case right explains itself: the judges' answer, and how sure they were of it.
    const refusedAs = async (said: Record<string, unknown>, sitting: Record<string, unknown> = {}) => {
      const items = judged(5).map((item, i) => (i === 2 ? { ...item, accepted: false, right: 18, of: 18, decision: "886", ...said } : item));
      return (await status(MAINNET, view({ state: "passed", closedAt: DEADLINE, items, licence, ...sitting })))[3];
    };
    expect(await refusedAs({ judges: "accept", confidenceBps: 4900 })).toBe("  Item 2    rejected (18 of 18 hidden cases right, judges accepted at 49%, decision 886): Item 2");
    expect(await refusedAs({ judges: "refuse", confidenceBps: 9000 })).toBe("  Item 2    rejected (18 of 18 hidden cases right, judges refused, 90% sure, decision 886): Item 2");
    // The bar is named when the sitting carries it, and only for an answer to accept that fell under it.
    expect(await refusedAs({ judges: "accept", confidenceBps: 4900 }, { barBps: 5000 })).toBe("  Item 2    rejected (18 of 18 hidden cases right, judges accepted at 49%, under the 50% bar, decision 886): Item 2");
    expect(await refusedAs({ judges: "refuse", confidenceBps: 9000 }, { barBps: 5000 })).toBe("  Item 2    rejected (18 of 18 hidden cases right, judges refused, 90% sure, decision 886): Item 2");
    // A host that kept how sure the judges were before it kept their answer reads as it did.
    expect(await refusedAs({ confidenceBps: 4900 })).toBe("  Item 2    rejected (18 of 18 hidden cases right, judges 49% sure, decision 886): Item 2");
    expect(passed.at(-1)).toBe("Passed, with 4 of 5 accepted. The licence is valid until 2100-03-02T02:00:00Z, for as long as the agent's id keeps its controller and its build.");
    const failed = await status(MAINNET, view({ state: "failed", closedAt: DEADLINE, items: judged(3) }));
    expect(failed.at(-1)).toBe(`Failed, with 3 of 5 accepted; a pass takes 4. \`${CLI} exam info\` says how long the agent waits before the next sitting.`);
  });

  it("reads the sitting saved last when none is named, and says when that one is paid for and not open yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainchain-exam-"));
    await expect(status(MAINNET, view(), { dir })).rejects.toThrow(`No sitting is saved for ${wallet.address} on BrainChain. Name one with --sitting <id>, or open one with \`${CLI} exam sit --agent-id <id>\`.`);
    saveSitting(wallet.address, MAINNET, { agentId: "77", class: "code", at: OPENED - 50, sitting: `0x${"11".repeat(32)}`, deadline: DEADLINE }, dir);
    saveSitting(wallet.address, MAINNET, { agentId: "501", class: "code", at: OPENED, sitting: SITTING, deadline: DEADLINE }, dir);
    expect((await status(MAINNET, view(), { dir }))[0]).toContain(`Sitting ${SITTING} for agent 501`);
    saveSitting(wallet.address, MAINNET, { agentId: "501", class: "code", at: OPENED + 9, request: { body: "{}", header: ["payment-signature", "abc"] } }, dir);
    await expect(status(MAINNET, view(), { dir })).rejects.toThrow(
      `The sitting for agent 501 was paid for at 2100-01-01T00:00:09Z, and the service has not answered for it. Run \`${CLI} exam sit --agent-id 501\` again: it sends the same request with the same payment, and nothing more is paid.`,
    );
  });

  it("shows a sitting before it opens by the state the service gives it, never as unknown", async () => {
    const before = (state: string, payment: string, extra: Record<string, unknown> = {}) => ({ sitting: SITTING, state, payment, message: "The sitting is paid for and its items are being drawn.", ...extra });
    const unkept = `Through the paid route only the request that paid for the sitting reads its briefs. Once it is open, \`${CLI} exam sit --agent-id <id>\` reads them with the signature of the wallet sitting it, and goes on with it.`;
    expect(await status(MAINNET, before("opening", "paid", { reason: "the pool has no item left to draw" }))).toEqual([`Sitting ${SITTING}: paid for, opening`, "  Not open yet: the pool has no item left to draw", unkept]);
    for (const payment of ["paying", "unconfirmed"]) expect(await status(MAINNET, before("paying", payment))).toEqual([`Sitting ${SITTING}: the service is settling its payment, and opens it once it has`, unkept]);
    expect(await status(MAINNET, before("unpaid", "failed"))).toEqual([`Sitting ${SITTING}: its payment did not settle, so nothing was charged and no sitting opens from it.`]);
    // The state alone says it: a reply that leaves the payment's own state out reads the same.
    expect(await status(MAINNET, { sitting: SITTING, state: "unpaid" })).toEqual([`Sitting ${SITTING}: its payment did not settle, so nothing was charged and no sitting opens from it.`]);
    // Failed is only ever a sitting that closed without a pass, whatever else the reply carries.
    expect((await status(MAINNET, view({ state: "failed", closedAt: DEADLINE, payment: "paid" })))[0]).toBe(`Sitting ${SITTING} for agent 501, class code: failed at 2100-01-01T02:00:00Z`);

    // The wallet that still keeps the paying request is told to send it again.
    const dir = mkdtempSync(join(tmpdir(), "brainchain-exam-"));
    saveSitting(wallet.address, MAINNET, { agentId: "501", class: "code", at: OPENED, sitting: SITTING, request: { body: "{}", header: ["payment-signature", "abc"] } }, dir);
    expect(await status(MAINNET, before("opening", "paid"), { dir })).toEqual([
      `Sitting ${SITTING}: paid for, opening`,
      `Run \`${CLI} exam sit --agent-id 501\` again: it sends the same request with the same payment, and nothing more is paid.`,
    ]);
  });

  it("says when the service has no such sitting", async () => {
    const lines: string[] = [];
    const read = examStatus(TESTNET, { sitting: SITTING, log: (line) => lines.push(line), fetcher: service(TESTNET).fetcher });
    await expect(read).rejects.toThrow(`The BrainChain service at brain.testnet.usebrainchain.com has no sitting ${SITTING}.`);
  });
});

describe("licence", () => {
  const signed = (extra: Record<string, unknown> = {}) => ({ licence: { class: "code", issuedAt: OPENED, expiresAt: OPENED + 60 * 86_400, accepted: 5, of: 5, ...extra }, signature: "0x01" });

  it("prints each licence with its state, on the chain the agent's id is on", async () => {
    const held = [
      { class: "code", state: "valid", licence: signed(), audits: { passed: 2, failed: 0 } },
      { class: "prose", state: "suspended", licence: signed({ accepted: 4 }), audits: { passed: 1, failed: 2 } },
      { class: "data", state: "lapsed", licence: signed(), audits: { passed: 0, failed: 0 } },
    ];
    const epoch = { id: `0x${"cd".repeat(32)}`, controller: wallet.address, build: "atlas 2.1" };
    const desk = service(MAINNET, { routes: { "GET /licences/4663/501": () => json({ agent: { chainId: 4663, id: "501" }, registry: "read", epoch, licences: held }) } });
    const lines: string[] = [];
    await licences(MAINNET, { agentId: "501", log: (line) => lines.push(line), fetcher: desk.fetcher });
    expect(lines).toEqual([
      "Licences of agent 501 on Robinhood Chain",
      `  Held to the registry as BrainChain read it within the last minute: controller ${wallet.address}, build "atlas 2.1"`,
      "  code  valid; issued 2100-01-01T00:00:00Z, expires 2100-03-02T00:00:00Z, earned with 5 of 5 accepted; audits: 2 passed, 0 failed",
      "  prose  suspended: two failed audits in the last three; issued 2100-01-01T00:00:00Z, expires 2100-03-02T00:00:00Z, earned with 4 of 5 accepted; audits: 1 passed, 2 failed",
      "  data  lapsed: the id now has another controller or build than the licence was earned with; issued 2100-01-01T00:00:00Z, expires 2100-03-02T00:00:00Z, earned with 5 of 5 accepted; audits: 0 passed, 0 failed",
    ]);
  });

  it("says when the registry could not be read and how old the states then are, and what they are held to otherwise", async () => {
    const held = [{ class: "code", state: "lapsed", licence: signed(), audits: { passed: 0, failed: 0 } }];
    const second = async (extra: Record<string, unknown>) => {
      const lines: string[] = [];
      const desk = service(MAINNET, { routes: { "GET /licences/4663/501": () => json({ licences: held, ...extra }) } });
      await licences(MAINNET, { agentId: "501", log: (line) => lines.push(line), fetcher: desk.fetcher });
      return lines[1];
    };
    const epoch = { id: `0x${"cd".repeat(32)}`, controller: wallet.address, build: "" };
    expect(await second({ registry: "unreadable", epoch: null })).toBe("  The registry could not be read just now, so these states are from BrainChain's last own reading, up to ten minutes old.");
    expect(await second({ registry: "read", epoch })).toBe(`  Held to the registry as BrainChain read it within the last minute: controller ${wallet.address}, build none declared`);
    expect(await second({ registry: "read", epoch: null })).toBe("  Held to the registry as BrainChain read it within the last minute: no single account controls the id");
    // A service that does not say whether it read the registry is quoted for what it does say, or not at all.
    expect(await second({ epoch })).toBe(`  Held to the id as BrainChain reads it now: controller ${wallet.address}, build none declared`);
    expect(await second({ epoch: null })).toBe("  BrainChain reads no controller and build for the id just now: it has no single controller, or the registry could not be read.");
    expect(await second({})).toMatch(/^ {2}code {2}lapsed: /);
  });

  it("says when the agent holds none, and when the exam is not open", async () => {
    const none = service(TESTNET, { routes: { "GET /licences/46630/7": () => json({ agent: { chainId: 46630, id: "7" }, licences: [] }) } });
    const lines: string[] = [];
    await licences(TESTNET, { agentId: "7", log: (line) => lines.push(line), fetcher: none.fetcher });
    expect(lines).toEqual([`Agent 7 on Robinhood Chain testnet holds no licence. \`${CLI} exam info\` says what a sitting takes.`]);
    await expect(licences(TESTNET, { agentId: "8", log: () => {}, fetcher: none.fetcher })).rejects.toThrow("The licence exam is not open on BrainChain testnet.");
  });
});

describe("papers", () => {
  const signed = {
    version: 1,
    agent: { chainId: 4663, registry: MAINNET.identity, id: "501" },
    at: OPENED + 60,
    epoch: { id: `0x${"cd".repeat(32)}`, controller: wallet.address, build: "atlas 2.1", number: 2, since: OPENED - 86_400 },
    record: { entries: 31, head: `0x${"ab".repeat(32)}`, url: `${MAINNET.service}/agents/4663/501/record`, thisEpoch: { "task:accepted": 12 }, earlierEpochs: 1, earlierEntries: 19 },
    licences: [{ class: "code", state: "valid", issuedAt: OPENED, expiresAt: OPENED + 60 * 86_400, sitting: SITTING, accepted: 5, of: 5, audits: { passed: 1, failed: 0 } }],
    ceiling: { units: "2500000", floor: "1000000", counted: "12500000", payers: [], halvedUntil: OPENED + 30 * 86_400 },
    verify: "npx brainchain-verify mainnet --record 501",
  };
  const file = (papersOf: unknown) => json({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Atlas", brainchain: { papers: papersOf, signed: "BrainChain papers\n{}", signature: "0x04" } });

  it("prints where the Papers are and what they say, then the two transactions as commands to copy, and sends nothing", async () => {
    const desk = service(MAINNET, { routes: { "GET /papers/4663/501": () => file(signed) } });
    const lines: string[] = [];
    await papers(MAINNET, { agentId: "501", log: (line) => lines.push(line), fetcher: desk.fetcher });
    const url = `${MAINNET.service}/papers/4663/501`;
    expect(lines.slice(0, 7)).toEqual([
      `Papers of agent 501 on Robinhood Chain: ${url}`,
      `  Epoch     2, since 2099-12-31T00:00:00Z; controller ${wallet.address}; build "atlas 2.1"`,
      `  Record    31 entries: ${MAINNET.service}/agents/4663/501/record`,
      "  Licence   code  valid; issued 2100-01-01T00:00:00Z, expires 2100-03-02T00:00:00Z, earned with 5 of 5 accepted; audits: 1 passed, 0 failed",
      "  Ceiling   2.5 USD in flight at most (floor 1), halved until 2100-01-31T00:00:00Z",
      `  Card      ${url}/card.svg`,
      "  Check     npx brainchain-verify mainnet --record 501",
    ]);
    expect(lines[7]).toBe(
      [
        "",
        "Two transactions the id's owner can send once, on Robinhood Chain. Both are optional, and this command sends neither.",
        "They are written for Foundry's cast, which asks for the key, so it never appears on the command line.",
        "",
        "  Point the id's URI at its Papers, so the record shows wherever the id's token is shown:",
        `    cast send ${MAINNET.identity} "setAgentURI(uint256,string)" 501 "${url}" --rpc-url https://rpc.mainnet.chain.robinhood.com --interactive`,
        "",
        "  Declare the build the agent runs, under the id's build key: one line of printable ASCII, at most 96 characters.",
        "  A build that starts with house: is read without that prefix.",
        "  A licence stands for the build declared when its sitting opened, so declare it before sitting: a change of build lapses the licence.",
        `    cast send ${MAINNET.identity} "setMetadata(uint256,string,bytes)" 501 build "$(cast from-utf8 '<build>')" --rpc-url https://rpc.mainnet.chain.robinhood.com --interactive`,
      ].join("\n"),
    );
    expect(lines).toHaveLength(8);
    expect(desk.read).toEqual(["/papers/4663/501"]);
  });

  it("says what the Papers leave out, and names no registry where this release has none", async () => {
    const bare = { ...signed, epoch: { ...signed.epoch, build: "", since: undefined }, record: undefined, licences: [], ceiling: undefined, verify: undefined };
    const desk = service(TESTNET, { routes: { "GET /papers/46630/9": () => file(bare) } });
    const lines: string[] = [];
    await papers(TESTNET, { agentId: "9", log: (line) => lines.push(line), fetcher: desk.fetcher });
    expect(lines.slice(1, 6)).toEqual([`  Epoch     2; controller ${wallet.address}; build none declared`, "  Record    no entry yet", "  Licences  none", "  Ceiling   not stated", `  Card      ${TESTNET.service}/papers/46630/9/card.svg`]);
    expect(lines.at(-1)).toContain("This release names no ERC-8004 registry on Robinhood Chain testnet: put the registry the id is on in place of <identity registry>.");
    expect(lines.at(-1)).toContain(`cast send <identity registry> "setAgentURI(uint256,string)" 9 "${TESTNET.service}/papers/46630/9" --rpc-url https://rpc.testnet.chain.robinhood.com --interactive`);
    await expect(papers(TESTNET, { agentId: "10", log: () => {}, fetcher: desk.fetcher })).rejects.toThrow(
      "The BrainChain service at brain.testnet.usebrainchain.com serves no Papers for agent 10 on Robinhood Chain testnet: no one controls that id, or Papers are not served on BrainChain testnet.",
    );
  });
});

describe("what the exam's lines never say", () => {
  it("is a dash for a pause", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const desk = service(MAINNET, { routes: { "GET /papers/4663/501": () => json({ brainchain: { papers: {} } }), "GET /licences/4663/501": () => json({ licences: [] }), [`GET /exams/${SITTING}`]: () => json(view()) } });
    await examInfo(MAINNET, { log, fetcher: desk.fetcher });
    await sitting(MAINNET, desk.fetcher, chainFor(), { maxPrice: 5_000_000n, log }).run();
    await examStatus(MAINNET, { sitting: SITTING, log, fetcher: desk.fetcher });
    await licences(MAINNET, { agentId: "501", log, fetcher: desk.fetcher });
    await papers(MAINNET, { agentId: "501", log, fetcher: desk.fetcher });
    expect(lines.length).toBeGreaterThan(30);
    expect(lines.join("\n")).not.toContain("—");
    expect(PERMIT2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
  });
});
