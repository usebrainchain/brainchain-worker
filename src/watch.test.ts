import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { TESTNET } from "./network.js";
import { argumentsOf, createWatch, judge, type QueuedChange, type WatchChain } from "./watch.js";

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
    head: vi.fn(async () => 2_000n),
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
    expect(lines[0]).toMatch(/^change 1: setWorkerAllowed on 0x0beA.*within the constitution, runs after 2027-01-15 08:00 UTC$/);
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
      "change 2: setFee on 0x0beA77333E26a257983fCc59B8D857730b5B1D2B breaks the constitution (a protocol fee above 5%), runs after 2027-01-15 08:00 UTC",
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
