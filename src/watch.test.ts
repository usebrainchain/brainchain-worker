import { encodeFunctionData, parseAbi, verifyMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { TESTNET } from "./network.js";
import { argumentsOf, createReporter, createWatch, fetchProof, judge, REPORT_PREFIX, type QueuedChange, type Report, type WatchChain } from "./watch.js";

const TX: Hex = `0x${"ab".repeat(32)}`;
const BOARD: Address = TESTNET.contracts.taskBoard;
const abi = parseAbi([
  "function setParameters(uint16 changeThresholdBps, uint64 timelock, uint32 houseTasksPerDay, uint128 maxHouseBounty, uint128 houseSpendPerDay)",
  "function setFee(uint16 feeBps, address feeRouter)",
  "function setWorkerAllowed(address account, bool allowed)",
  "function setOwner(address owner)",
]);

const change = (changeId: bigint, data: Hex, target: Address = BOARD): QueuedChange => ({ changeId, decisionId: changeId, target, data, eta: 1_800_000_000n, block: 10n });

function fakeChain(options: { queued?: QueuedChange[]; open?: boolean; decisions?: bigint[]; gate?: boolean } = {}) {
  const vetoes: string[] = [];
  const counts = options.decisions ?? [3n];
  let round = 0;
  const chain: WatchChain = {
    account: "0x00000000000000000000000000000000000000C1",
    head: vi.fn(async () => 3_000n),
    queued: vi.fn(async () => options.queued ?? []),
    open: vi.fn(async () => options.open ?? true),
    decisions: vi.fn(async () => counts[Math.min(round++, counts.length - 1)]!),
    ...(options.gate === false
      ? {}
      : {
          veto: vi.fn(async (changeId: bigint, why: string) => {
            vetoes.push(`${changeId}: ${why}`);
            return TX;
          }),
        }),
  };
  return { chain, vetoes };
}

describe("judging changes", () => {
  it("reads a call's static words and applies the constitution's floors", () => {
    const fine = encodeFunctionData({ abi, functionName: "setParameters", args: [6_000, 86_400n, 5, 2_000_000n, 10_000_000n] });
    expect(argumentsOf(fine)).toEqual([6_000n, 86_400n, 5n, 2_000_000n, 10_000_000n]);
    expect(judge(fine)).toEqual({ name: "setParameters", broken: [] });
    const low = encodeFunctionData({ abi, functionName: "setParameters", args: [5_000, 3_600n, 25, 2_000_000n, 10_000_000n] });
    expect(judge(low).broken).toEqual(["the change bar falls below 60%", "the timelock falls below 24 hours", "more than 20 house tasks a day"]);
    expect(judge(encodeFunctionData({ abi, functionName: "setFee", args: [600, BOARD] })).broken).toEqual(["a protocol fee above 5%"]);
    expect(judge(encodeFunctionData({ abi, functionName: "setWorkerAllowed", args: [BOARD, true] })).broken).toEqual([]);
    expect(judge(encodeFunctionData({ abi, functionName: "setOwner", args: [BOARD] })).broken).toEqual(["a call the constitution does not list"]);
  });
});

describe("watch", () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  it("reports a change within the constitution and leaves it alone", async () => {
    lines.length = 0;
    const { chain, vetoes } = fakeChain({ queued: [change(1n, encodeFunctionData({ abi, functionName: "setWorkerAllowed", args: [BOARD, true] }))] });
    const watch = createWatch({ network: TESTNET, chain, veto: true, log });
    expect(await watch.round()).toEqual({ findings: 0 });
    expect(lines[0]).toMatch(/^change 1: setWorkerAllowed on 0x7A7cC.*within the constitution, runs after 2027-01-15 08:00 UTC$/);
    expect(vetoes).toEqual([]);
    // A later round does not judge the same change again.
    await watch.round();
    expect(lines.filter((l) => l.startsWith("change 1")).length).toBe(1);
  });

  it("vetoes a change that crosses a floor through the gate, with the reason", async () => {
    lines.length = 0;
    const bad = encodeFunctionData({ abi, functionName: "setFee", args: [600, BOARD] });
    const { chain, vetoes } = fakeChain({ queued: [change(2n, bad)] });
    const watch = createWatch({ network: TESTNET, chain, veto: true, log });
    expect(await watch.round()).toEqual({ findings: 1 });
    expect(vetoes).toEqual(["2: Breaks the constitution: a protocol fee above 5%"]);
    expect(lines).toEqual([
      "change 2: setFee on 0x7A7cC5D35A642CCc268C7B263fF800bc7eBD52A4 breaks the constitution (a protocol fee above 5%), runs after 2027-01-15 08:00 UTC",
      `vetoed change 2 through the guardian gate: ${TX}`,
    ]);
  });

  it("only reports without --veto, and says when there is no gate to veto through", async () => {
    lines.length = 0;
    const bad = encodeFunctionData({ abi, functionName: "setFee", args: [600, BOARD] });
    const reporting = fakeChain({ queued: [change(2n, bad)] });
    expect(await createWatch({ network: TESTNET, chain: reporting.chain, veto: false, log }).round()).toEqual({ findings: 1 });
    expect(reporting.vetoes).toEqual([]);
    const gateless = fakeChain({ queued: [change(2n, bad)], gate: false });
    await createWatch({ network: TESTNET, chain: gateless.chain, veto: true, log }).round();
    expect(lines.at(-1)).toBe("cannot veto: BrainChain testnet has no guardian gate this worker can reach");
    const closed = fakeChain({ queued: [change(2n, bad)], open: false });
    await createWatch({ network: TESTNET, chain: closed.chain, veto: true, log }).round();
    expect(lines.at(-1)).toBe("change 2 is closed already, nothing to veto");
    expect(closed.vetoes).toEqual([]);
  });

  it("notes where the decision log stands, then re-verifies every new decision", async () => {
    lines.length = 0;
    const { chain } = fakeChain({ decisions: [3n, 5n] });
    const verify = vi.fn(async (id: bigint) => ({ findings: id === 5n ? ["record hash: does not match payloadHash"] : [] }));
    const watch = createWatch({ network: TESTNET, chain, verify, veto: false, log });
    await watch.round();
    expect(lines).toEqual(["3 decisions recorded so far; new ones are checked from here"]);
    expect(await watch.round()).toEqual({ findings: 1 });
    expect(verify.mock.calls.map((c) => c[0])).toEqual([4n, 5n]);
    expect(lines.slice(1)).toEqual(["decision 4 verified", "decision 5 does not verify: record hash: does not match payloadHash"]);
  });
});

describe("a one-shot run", () => {
  it("checks the latest decisions on a first run, then what was added since", async () => {
    const { chain } = fakeChain({ decisions: [12n] });
    const verify = vi.fn(async () => ({ findings: [] }));
    const seen: bigint[] = [];
    const first = createWatch({ network: TESTNET, chain, verify, veto: false, log: () => {}, recent: 3n, saw: (n) => seen.push(n) });
    await first.round();
    expect(verify.mock.calls.map((c) => (c as unknown as [bigint])[0])).toEqual([10n, 11n, 12n]);
    expect(seen).toEqual([12n]);

    verify.mockClear();
    const next = fakeChain({ decisions: [14n] }).chain;
    await createWatch({ network: TESTNET, chain: next, verify, veto: false, log: () => {}, seenDecision: 12n, recent: 3n }).round();
    expect(verify.mock.calls.map((c) => (c as unknown as [bigint])[0])).toEqual([13n, 14n]);
  });

  it("starts over when the log has fewer decisions than the count it kept", async () => {
    const { chain } = fakeChain({ decisions: [2n] });
    const verify = vi.fn(async () => ({ findings: [] }));
    await createWatch({ network: TESTNET, chain, verify, veto: false, log: () => {}, seenDecision: 34n, recent: 10n }).round();
    expect(verify.mock.calls.map((c) => (c as unknown as [bigint])[0])).toEqual([1n, 2n]);
  });
});

describe("reporting rounds", () => {
  const worker = privateKeyToAccount(`0x${"7".repeat(64)}`);
  const record = new TextEncoder().encode('{"kind":"hire"}');

  it("sends a signed report of the decisions re-verified and the findings, and logs the service's answer", async () => {
    const calls: { url: string; body: { report: string; signature: Hex } }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as { report: string; signature: Hex } });
      return new Response(JSON.stringify({ checked: 3, mark: null, markAfter: 10 }), { status: 200 });
    }) as typeof fetch;
    const report = createReporter(TESTNET, worker, fetcher);
    const line = await report([{ id: 4n, proof: fetchProof(record, worker.address) }], [{ id: 5n, checks: ["record-hash: differs"] }]);
    expect(line).toBe("reported to BrainChain testnet: 3 of the 10 re-verified decisions that earn the watchtower mark");
    expect(calls[0]!.url).toBe(`${TESTNET.service}/watchtowers/reports`);
    const sent = JSON.parse(calls[0]!.body.report) as { worker: string; chainId: number; log: string; checked: unknown[]; findings: unknown[] };
    expect(sent).toMatchObject({ worker: worker.address, chainId: TESTNET.chainId, log: TESTNET.contracts.log, findings: [{ id: 5, checks: ["record-hash: differs"] }] });
    expect(sent.checked).toEqual([{ id: 4, proof: fetchProof(record, worker.address) }]);
    expect(await verifyMessage({ address: worker.address, message: `${REPORT_PREFIX}${calls[0]!.body.report}`, signature: calls[0]!.body.signature })).toBe(true);
  });

  it("names the mark once the service grants it, and the refusal when it does not take the report", async () => {
    const granted = createReporter(TESTNET, worker, (async () => new Response(JSON.stringify({ checked: 12, mark: { since: "2026-11-02", checked: 12 } }), { status: 200 })) as typeof fetch);
    expect(await granted([{ id: 1n, proof: fetchProof(record, worker.address) }], [])).toBe("reported to BrainChain testnet: 12 decisions re-verified in all, watchtower mark since 2026-11-02");
    const refused = createReporter(TESTNET, worker, (async () => new Response(JSON.stringify({ error: "The proof for decision 1 does not match its record." }), { status: 400 })) as typeof fetch);
    await expect(refused([{ id: 1n, proof: fetchProof(record, worker.address) }], [])).rejects.toThrow("The proof for decision 1 does not match its record.");
  });

  it("reports after a round that re-verified decisions, with the proof bound to the worker, and goes on when the service refuses", async () => {
    const { chain } = fakeChain({ decisions: [2n, 4n, 5n] });
    const lines: string[] = [];
    const reports: Parameters<Report>[] = [];
    let refuse = false;
    const watch = createWatch({
      network: TESTNET,
      chain,
      veto: false,
      log: (line) => lines.push(line),
      verify: async (id) => (id === 4n ? { findings: ["record-hash: differs"] } : { findings: [], record }),
      report: async (checked, findings) => {
        reports.push([checked, findings]);
        if (refuse) throw new Error("The report was signed too long ago.");
        return "reported";
      },
    });
    await watch.round();
    expect(reports).toEqual([]);
    await watch.round();
    expect(reports).toEqual([[[{ id: 3n, proof: fetchProof(record, chain.account) }], [{ id: 4n, checks: ["record-hash: differs"] }]]]);
    expect(lines.at(-1)).toBe("reported");
    refuse = true;
    await watch.round();
    expect(reports).toHaveLength(2);
    expect(lines.at(-1)).toBe("report not taken: The report was signed too long ago.");
  });

  it("sends nothing without a reporter or when a round re-verified nothing", async () => {
    const { chain } = fakeChain({ decisions: [2n, 2n, 3n] });
    const reports: unknown[] = [];
    const watch = createWatch({ network: TESTNET, chain, veto: false, log: () => {}, verify: async () => ({ findings: [] }), report: async (...args) => (reports.push(args), "reported") });
    await watch.round();
    await watch.round();
    expect(reports).toEqual([]);
    // Verified without a record (the refetch failed): nothing to prove, so nothing is sent.
    await watch.round();
    expect(reports).toEqual([]);
  });
});
