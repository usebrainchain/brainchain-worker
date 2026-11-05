import { decodeAbiParameters, decodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { bond, bondClaim, bondGas, bondLine, bondStatus, bondTerms, deedPage, BOND_LEAD_SEC, DeedStatus, encodeCheckData, GAS, MIN_BOND, proofIndexAbi, Ruling, taskOfCheck, type BondChain, type BondConfig, type BondView, type TaskFacts, type BondTerms } from "./bond.js";
import { Status } from "./chain.js";
import { MAINNET, TESTNET } from "./network.js";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000C1";
const POSTER: Address = "0x00000000000000000000000000000000000000D1";
const INDEX: Address = "0x00000000000000000000000000000000000000f1";
const TX: Hex = `0x${"fe".repeat(32)}`;
const USDG = (n: string) => parseUnits(n, 6);
const NOW = 1_800_000_000n;
const config: BondConfig & { proofIndex: Address } = { ...MAINNET.proofs.bonds!, proofIndex: INDEX };
const task = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({ poster: POSTER, bounty: USDG("1"), deadline: NOW + 86_400n, status: Status.Hired, model: `0x${"0".repeat(24)}${ACCOUNT.slice(2)}`, ...overrides });
const view = (overrides: Partial<BondView> = {}): BondView => ({ deed: 4n, task: 12n, amount: USDG("5"), deadline: NOW + 86_400n + BOND_LEAD_SEC, status: DeedStatus.Open, ruling: 0, remainderBps: 0, checkMetAt: 0n, settledAt: 0n, refundTo: POSTER, ...overrides });

function fakeChain(options: { task?: TaskFacts; bonds?: BondView[]; usdg?: bigint; eth?: bigint; allowance?: bigint; owed?: bigint; proof?: bigint; payer?: Address } = {}) {
  return {
    account: ACCOUNT,
    task: vi.fn(async () => options.task),
    now: vi.fn(async () => NOW),
    usdgBalance: vi.fn(async () => options.usdg ?? USDG("100")),
    ethBalance: vi.fn(async () => options.eth ?? parseUnits("0.01", 18)),
    gasPrice: vi.fn(async () => 20_000_000n),
    allowance: vi.fn(async () => options.allowance ?? 0n),
    approve: vi.fn(async () => TX),
    create: vi.fn(async (_terms: BondTerms, _amount: bigint) => ({ deed: 7n, tx: TX })),
    bondsOn: vi.fn(async () => options.bonds ?? []),
    proofOf: vi.fn(async () => options.proof ?? 0n),
    owed: vi.fn(async () => options.owed ?? 0n),
    withdraw: vi.fn(async () => ({ amount: options.owed ?? 0n, tx: TX })),
    payerOf: vi.fn(async () => options.payer),
  } satisfies BondChain;
}

async function run(chain: BondChain, amount: string, options: { yes?: boolean; answer?: string; config?: BondConfig | undefined; network?: typeof MAINNET; fetch?: typeof fetch } = {}) {
  const lines: string[] = [];
  const ask = options.answer === undefined ? undefined : vi.fn(async () => options.answer!);
  await bond(options.network ?? MAINNET, "config" in options ? options.config : config, chain, 12n, { amount: USDG(amount), yes: options.yes ?? false, fetch: options.fetch ?? (async () => { throw new Error("no network in tests"); }), ...(ask ? { ask } : {}), log: (line) => lines.push(line) });
  return { lines, ask };
}

describe("ShippedDeeds' enums", () => {
  it("pins Ruling as the contract declares it: Conceded is 5 and CheckMet 7, and a line reads the settled split, never the ruling number", () => {
    expect(Ruling).toEqual({ None: 0, Accepted: 1, Rejected: 2, Partial: 3, Invalid: 4, Conceded: 5, Default: 6, CheckMet: 7 });
    expect(DeedStatus).toEqual({ None: 0, Open: 1, Ruled: 2, Appealed: 3, Settled: 4 });
    const delivered = view({ status: DeedStatus.Settled, ruling: Ruling.CheckMet, remainderBps: 10_000, settledAt: NOW });
    expect(delivered.ruling).toBe(7);
    expect(bondLine(MAINNET, delivered, true, NOW)).toContain("delivered at");
    expect(bondLine(MAINNET, view({ status: DeedStatus.Settled, ruling: Ruling.Conceded, remainderBps: 0, settledAt: NOW }), false, NOW)).toContain("missed: paid to the poster");
  });
});

describe("bondTerms", () => {
  it("builds the terms Shipped's create accepts for a check-only bond, keyed by board and task, with the refund side named", () => {
    const board = MAINNET.contracts.taskBoard;
    const terms = bondTerms(config, { id: 12n, refundTo: POSTER, paidThroughDesk: false, deadline: NOW }, { address: board, chainId: MAINNET.chainId });
    expect(terms.title).toBe("BrainChain task #12");
    expect(Buffer.byteLength(terms.title)).toBeLessThanOrEqual(96);
    expect(Buffer.byteLength(terms.milestone)).toBeLessThanOrEqual(2048);
    expect(terms.milestone).toContain(`proofOf(${board}, 12) >= 1`);
    expect(terms.milestone).toContain(INDEX);
    expect(terms.milestone).toContain(`paid to ${POSTER}, the task's poster`);
    expect(bondTerms(config, { id: 12n, refundTo: ACCOUNT, paidThroughDesk: true, deadline: NOW }, { address: board, chainId: MAINNET.chainId }).milestone).toContain(
      `paid to ${ACCOUNT}, the agent that paid BrainChain's desk for the task`,
    );
    expect(terms).toMatchObject({
      project: "0x0000000000000000000000000000000000000000",
      projectKind: 0,
      asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      deadline: NOW + 48n * 3_600n,
      verifier: "0x0000000000000000000000000000000000000000",
      backupVerifier: "0x0000000000000000000000000000000000000000",
      appealPanel: "0x0000000000000000000000000000000000000000",
      check: "0x2e7C4F0F2e6079C3B5F7Cd2440308234CBDc537D",
      refundTo: POSTER,
      defaultRemainderBps: 0,
      refundCapBps: 0,
      allowPartial: false,
      verifierGrace: 0,
      backupGrace: 0,
      appealWindow: 0,
      panelWindow: 0,
      appealBond: 0n,
      verifierFee: 0n,
      refundExcluded: [],
    });
    const [target, call, op, threshold] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "uint8" }, { type: "uint256" }], terms.checkData);
    expect([target, op, threshold]).toEqual([INDEX, 0, 1n]);
    expect(decodeFunctionData({ abi: proofIndexAbi, data: call })).toEqual({ functionName: "proofOf", args: [board, 12n] });
    expect(taskOfCheck(terms.checkData, INDEX, board)).toBe(12n);
    expect(taskOfCheck(terms.checkData, POSTER, board)).toBeUndefined();
    expect(taskOfCheck(terms.checkData, INDEX, POSTER)).toBeUndefined();
    expect(taskOfCheck(encodeCheckData(INDEX, board, 3n), INDEX, board)).toBe(3n);
  });
});

describe("bond", () => {
  it("shows the all-in cost, asks, then approves and opens the bond", async () => {
    const chain = fakeChain({ task: task() });
    const { lines, ask } = await run(chain, "5", { answer: "y" });
    expect(ask).toHaveBeenCalledWith("Send it? [y/N] ");
    expect(lines[0]).toBe(
      [
        "Bond 5 USDG on task 12 (bounty 1 USDG, deadline 2027-01-16T08:00:00Z).",
        "  Released by the task's Proof: 4.95 USDG back after Shipped's 1% fee (0.05 USDG), collected with `bond claim 12`.",
        "  Missed: if no Proof is recorded by 2027-01-18T08:00:00Z, the 5 USDG goes to 0x00000000000000000000000000000000000000D1, the poster.",
        `  Gas now: about ${(Number(GAS.create + GAS.approve) * 0.02) / 1e9} ETH on Robinhood Chain for the approval and the bond at 0.02 gwei; the claim later costs about ${(Number(GAS.withdraw) * 0.02) / 1e9} ETH.`,
      ].join("\n"),
    );
    expect(chain.approve).toHaveBeenCalledWith(USDG("5"));
    expect(chain.create).toHaveBeenCalledOnce();
    const [terms, amount] = chain.create.mock.calls[0]!;
    expect(amount).toBe(USDG("5"));
    expect(terms.refundTo).toBe(POSTER);
    expect(terms.deadline).toBe(NOW + 86_400n + BOND_LEAD_SEC);
    expect(lines.at(-1)).toBe(`Bond No. 7 is open on Shipped (${TX}). Jev reads it when it hires; \`bond status 12\` follows it.`);
    expect(bondGas(20_000_000n, true)).toBe((GAS.create + GAS.approve) * 20_000_000n);
  });

  it("skips the approval when the allowance covers the bond, and sends nothing on no", async () => {
    const chain = fakeChain({ task: task(), allowance: USDG("10") });
    const { lines } = await run(chain, "5", { answer: "n" });
    expect(lines[0]).toContain("for the bond at 0.02 gwei");
    expect(lines.at(-1)).toBe("Nothing sent.");
    expect(chain.approve).not.toHaveBeenCalled();
    expect(chain.create).not.toHaveBeenCalled();
    await run(chain, "5", { yes: true });
    expect(chain.approve).not.toHaveBeenCalled();
    expect(chain.create).toHaveBeenCalledOnce();
  });

  it("pays the agent that paid the desk for the task, and refuses a task this wallet paid for", async () => {
    const payer: Address = "0x00000000000000000000000000000000000000E1";
    const chain = fakeChain({ task: task({ poster: "0x00000000000000000000000000000000000000De" }), payer });
    const { lines } = await run(chain, "5", { yes: true });
    expect(chain.payerOf).toHaveBeenCalledWith(12n);
    const [terms] = chain.create.mock.calls[0]!;
    expect(terms.refundTo).toBe(payer);
    expect(terms.milestone).toContain(`paid to ${payer}, the agent that paid BrainChain's desk for the task`);
    expect(lines[0]).toContain(`the 5 USDG goes to ${payer}, the agent that paid for the task.`);
    const own = fakeChain({ task: task({ poster: "0x00000000000000000000000000000000000000De" }), payer: ACCOUNT });
    await expect(run(own, "5", { yes: true })).rejects.toThrow("Task 12 was paid for by this wallet.");
    expect(own.create).not.toHaveBeenCalled();
  });

  it("needs --yes where there is no terminal", async () => {
    const chain = fakeChain({ task: task() });
    await expect(run(chain, "5")).rejects.toThrow("There is no terminal to confirm on. Run again with --yes to send without asking.");
    expect(chain.create).not.toHaveBeenCalled();
  });

  it("refuses a task the wallet posted, an amount under the bounty or under 2 USDG, and a task it cannot bond", async () => {
    for (const [chain, amount, error] of [
      [fakeChain({ task: task({ poster: ACCOUNT }) }), "5", "Task 12 was posted by this wallet."],
      [fakeChain({ task: task({ bounty: USDG("8") }) }), "5", "The bond must be at least the task's bounty, 8 USDG; 5 USDG is under it."],
      [fakeChain({ task: task() }), "1.5", `The bond must be at least ${Number(MIN_BOND) / 1e6} USDG`],
      [fakeChain({ task: undefined }), "5", "There is no task 12 on BrainChain."],
      [fakeChain({ task: task({ status: Status.Hired, model: `0x${"0".repeat(24)}${"a".repeat(40)}` }) }), "5", "Task 12 is not hired to this worker. Bond a task after Jev hires you for it."],
      [fakeChain({ task: task({ status: Status.Paid }) }), "5", "Task 12 is not hired to this worker. Bond a task after Jev hires you for it."],
      [fakeChain({ task: task({ deadline: NOW - 1n }) }), "5", "deadline, 2027-01-15T07:59:59Z, has passed"],
      [fakeChain({ task: task(), bonds: [view()] }), "5", "This worker already has bond No. 4 open on task 12."],
      [fakeChain({ task: task(), usdg: USDG("4") }), "5", `${ACCOUNT} holds 4 USDG on Robinhood Chain, under the 5 USDG to bond. Nothing was sent.`],
      [fakeChain({ task: task(), eth: 0n }), "5", "holds 0 ETH on Robinhood Chain, under the"],
    ] as const) {
      await expect(run(chain, amount, { yes: true })).rejects.toThrow(error);
      expect(chain.create).not.toHaveBeenCalled();
    }
    // A task hired to this worker can still be bonded; a settled bond on it does not stand in the way.
    const hired = fakeChain({ task: task({ status: Status.Hired, model: `0x${ACCOUNT.slice(2).padStart(64, "0")}` }), bonds: [view({ status: DeedStatus.Settled, remainderBps: 10_000 })] });
    await run(hired, "5", { yes: true });
    expect(hired.create).toHaveBeenCalledOnce();
  });

  it("says when bonds are closed: no registry on testnet, no index yet on mainnet", async () => {
    const chain = fakeChain({ task: task() });
    await expect(run(chain, "5", { yes: true, network: TESTNET, config: TESTNET.proofs.bonds })).rejects.toThrow("Bonds run on Robinhood Chain against Shipped's registry, which BrainChain testnet has no counterpart of.");
    await expect(run(chain, "5", { yes: true, config: { ...MAINNET.proofs.bonds!, proofIndex: undefined } })).rejects.toThrow("Bonds are not open yet: BrainChain's ProofIndex on Robinhood Chain, which a bond's check reads, is not deployed.");
    expect(chain.task).not.toHaveBeenCalled();
  });
});

describe("bond status", () => {
  it("prints each bond's state in one line", async () => {
    const lines: string[] = [];
    const deadline = NOW + 86_400n;
    await bondStatus(MAINNET, config, fakeChain({ bonds: [view({ deadline })] }), 12n, (l) => lines.push(l), (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(lines).toEqual(["Bond No. 4 on task 12: 5 USDG, open until 2027-01-16T08:00:00Z: waiting for the task to be paid and its Proof recorded"]);
    expect(bondLine(MAINNET, view({ deadline }), true, NOW)).toBe("Bond No. 4 on task 12: 5 USDG, open until 2027-01-16T08:00:00Z: the Proof is in the index and BrainChain marks the check shortly");
    expect(bondLine(MAINNET, view({ deadline, checkMetAt: NOW - 600n }), true, NOW)).toBe("Bond No. 4 on task 12: 5 USDG, the Proof is in the index and the check was marked at 2027-01-15T07:50:00Z; BrainChain confirms it after 2027-01-15T08:50:00Z");
    expect(bondLine(MAINNET, view({ deadline, checkMetAt: NOW - 4_000n }), true, NOW)).toContain("BrainChain confirms it shortly");
    expect(bondLine(MAINNET, view({ deadline: NOW - 1n }), false, NOW)).toBe("Bond No. 4 on task 12: 5 USDG, deadline 2027-01-15T07:59:59Z passed with no Proof recorded; it settles to the poster 0x00000000000000000000000000000000000000D1 after 2027-01-16T08:59:59Z");
    expect(bondLine(MAINNET, view({ status: DeedStatus.Settled, remainderBps: 10_000, settledAt: NOW }), true, NOW)).toBe("Bond No. 4 on task 12: 5 USDG, delivered at 2027-01-15T08:00:00Z: 4.95 USDG back after Shipped's 1% fee (bond claim 12 collects it)");
    lines.length = 0;
    await bondStatus(MAINNET, config, fakeChain(), 12n, (l) => lines.push(l));
    expect(lines).toEqual([`${ACCOUNT} has no bond on task 12.`]);
  });
});

describe("bond claim", () => {
  it("withdraws what a delivered bond left, and says when there is nothing to collect", async () => {
    const lines: string[] = [];
    const delivered = view({ status: DeedStatus.Settled, ruling: Ruling.CheckMet, remainderBps: 10_000, settledAt: NOW });
    const chain = fakeChain({ bonds: [delivered], owed: USDG("4.95") });
    await bondClaim(MAINNET, config, chain, 12n, (l) => lines.push(l));
    expect(chain.withdraw).toHaveBeenCalledOnce();
    expect(lines).toEqual(["Claiming 4.95 USDG from Shipped's registry on Robinhood Chain...", `Paid 4.95 USDG to ${ACCOUNT} (${TX}).`]);

    lines.length = 0;
    await bondClaim(MAINNET, config, fakeChain({ bonds: [delivered] }), 12n, (l) => lines.push(l));
    expect(lines).toEqual(["Bond No. 4 was delivered and its 4.95 USDG already withdrawn."]);
    lines.length = 0;
    await bondClaim(MAINNET, config, fakeChain({ bonds: [view({ status: DeedStatus.Settled, ruling: Ruling.Default, settledAt: NOW })] }), 12n, (l) => lines.push(l));
    expect(lines).toEqual([`Bond No. 4 was missed: its 5 USDG went to the poster ${POSTER}, so there is nothing to claim.`]);
  });

  it("refuses while the bond is open, without a bond, and without gas", async () => {
    const open = fakeChain({ bonds: [view()] });
    await expect(bondClaim(MAINNET, config, open, 12n, () => {})).rejects.toThrow(/open until .*\. It can be claimed once it has settled\./);
    expect(open.withdraw).not.toHaveBeenCalled();
    await expect(bondClaim(MAINNET, config, fakeChain(), 12n, () => {})).rejects.toThrow(`${ACCOUNT} has no bond on task 12.`);
    const dry = fakeChain({ bonds: [view({ status: DeedStatus.Settled, remainderBps: 10_000 })], owed: USDG("4.95"), eth: 0n });
    await expect(bondClaim(MAINNET, config, dry, 12n, () => {})).rejects.toThrow(`${ACCOUNT} has no ETH on Robinhood Chain to pay gas for the claim.`);
    expect(dry.withdraw).not.toHaveBeenCalled();
  });
});

describe("deed page", () => {
  const page = { deed: { number: "3", url: "https://app.shipped.bond/bonds/3" } };
  const answering = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it("reads Shipped's number and link, and stands down on a test bond, an error or no network", async () => {
    expect(await deedPage(4n, answering(page))).toEqual({ number: "3", url: "https://app.shipped.bond/bonds/3" });
    expect(await deedPage(4n, answering({ deed: { number: null, url: null } }))).toBeUndefined();
    expect(await deedPage(4n, answering({}, false))).toBeUndefined();
    expect(await deedPage(4n, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeUndefined();
  });

  it("names the bond by Shipped's number and page after creating it", async () => {
    const chain = fakeChain({ task: task() });
    const { lines } = await run(chain, "5", { yes: true, fetch: answering(page) });
    expect(lines.at(-1)).toBe(`Bond No. 3 is open on Shipped: https://app.shipped.bond/bonds/3 (${TX}). Jev reads it when it hires; \`bond status 12\` follows it.`);
  });

  it("shows the page on each status line when Shipped knows the bond", async () => {
    const lines: string[] = [];
    const deadline = NOW + 86_400n;
    await bondStatus(MAINNET, config, fakeChain({ bonds: [view({ deadline })] }), 12n, (l) => lines.push(l), answering(page));
    expect(lines).toEqual(["Bond No. 3 on task 12: 5 USDG, open until 2027-01-16T08:00:00Z: waiting for the task to be paid and its Proof recorded https://app.shipped.bond/bonds/3"]);
  });
});
