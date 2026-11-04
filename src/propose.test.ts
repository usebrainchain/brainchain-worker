import { decodeFunctionData, parseEther, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { MAINNET, TESTNET } from "./network.js";
import { buildCall, caseURI, GOVERNED, proposal, propose, ProposalError, type Call, type ProposalChain } from "./propose.js";

const ME: Address = "0x00000000000000000000000000000000000000C1";
const ROUTER: Address = "0x15Cf18dBA874EA0c77ED8Cecf38aDa64697102fb";
const TX: Hex = `0x${"fe".repeat(32)}`;
const CONFIG = {
  hireThresholdBps: 1500,
  gradeThresholdBps: 7000,
  ruleThresholdBps: 7000,
  minDuration: 900,
  maxDuration: 259200,
  gradeWindow: 21600,
  disputeWindow: 3600,
  ruleWindow: 21600,
  minBounty: "1000000",
};

const decode = (call: Call) => decodeFunctionData({ abi: GOVERNED[call.target], data: call.data });

describe("buildCall", () => {
  it("encodes a call on the board from --call and --args", () => {
    const call = buildCall(MAINNET, ME, { target: "board", call: "setFee", args: `[300, "${ROUTER.toLowerCase()}"]` });
    expect(call.address).toBe(MAINNET.contracts.taskBoard);
    expect(call.text).toBe(`setFee(300, ${ROUTER})`);
    expect(decode(call).args).toEqual([300, ROUTER]);
  });

  it("takes a tuple as an object with every field", () => {
    const call = buildCall(TESTNET, ME, { target: "board", call: "setConfig", args: JSON.stringify([CONFIG]) });
    expect(decode(call).args?.[0]).toMatchObject({ minDuration: 900n, minBounty: 1000000n });
    expect(() => buildCall(TESTNET, ME, { target: "board", call: "setConfig", args: '[{"hireThresholdBps":1500}]' })).toThrow(/missing gradeThresholdBps/);
    expect(() => buildCall(TESTNET, ME, { target: "board", call: "setConfig", args: JSON.stringify([{ ...CONFIG, fee: 1 }]) })).toThrow(/no field fee/);
  });

  it("resolves the registry and the executor, by name or address", () => {
    const model = buildCall(MAINNET, ME, { target: "registry", call: "setModel", args: `["0x${"ab".repeat(32)}", "${ROUTER}", "200000", false]` });
    expect(model.address).toBe(MAINNET.contracts.registry);
    const transfer = buildCall(MAINNET, ME, { target: MAINNET.contracts.executor.toLowerCase(), call: "transfer", args: `["${ROUTER}", 5000000]` });
    expect(transfer.target).toBe("executor");
    expect(transfer.text).toBe(`transfer(${ROUTER}, 5000000)`);
  });

  it("decodes raw --data and refuses trailing bytes or unknown selectors", () => {
    const data = buildCall(MAINNET, ME, { target: "board", call: "setPaused", args: "[true]" }).data;
    expect(buildCall(MAINNET, ME, { target: "board", data }).text).toBe("setPaused(true)");
    expect(() => buildCall(MAINNET, ME, { target: "board", data: `${data}00` })).toThrow(/beyond the call's arguments/);
    expect(() => buildCall(MAINNET, ME, { target: "board", data: "0xdeadbeef" })).toThrow(/selector 0xdeadbeef is none of them/);
    expect(() => buildCall(MAINNET, ME, { target: "board", data, call: "setPaused" })).toThrow(/either --data or --call/);
  });

  it("refuses what the executor never queues, and sends a self-application to join", () => {
    expect(() => buildCall(MAINNET, ME, { target: "board", call: "setGuardian", args: `["${ROUTER}"]` })).toThrow(/never queued/);
    expect(() => buildCall(MAINNET, ME, { target: "treasury", call: "transfer" })).toThrow(/board, executor or registry/);
    expect(() => buildCall(MAINNET, ME, { target: "board", call: "setWorkerAllowed", args: `["${ME}", true]` })).toThrow(/run join/);
    expect(buildCall(MAINNET, ME, { target: "board", call: "setWorkerAllowed", args: `["${ROUTER}", false]` }).text).toBe(`setWorkerAllowed(${ROUTER}, false)`);
  });

  it("checks argument count and types", () => {
    expect(() => buildCall(MAINNET, ME, { target: "board", call: "setFee", args: "[300]" })).toThrow(/takes 2 arguments \(feeBps, feeRouter\)/);
    expect(() => buildCall(MAINNET, ME, { target: "board", call: "setFee", args: `[3.5, "${ROUTER}"]` })).toThrow(/feeBps must be a whole number/);
    expect(() => buildCall(MAINNET, ME, { target: "board", call: "setPaused", args: '["yes"]' })).toThrow(/paused must be true or false/);
    expect(() => buildCall(MAINNET, ME, { target: "board", call: "setFee", args: "300" })).toThrow(/takes 2 arguments/);
    expect(() => buildCall(MAINNET, ME, { target: "board", call: "setFee", args: "[300," })).toThrow(/must be a JSON array/);
  });
});

describe("caseURI", () => {
  const call = buildCall(MAINNET, ME, { target: "board", call: "setPaused", args: "[false]" });
  const read = (uri: string) => JSON.parse(Buffer.from(uri.split(",")[1]!, "base64").toString("utf8")) as Record<string, string>;

  it("writes the case as base64 JSON, with the call as the proposed value by default", () => {
    expect(read(caseURI(call, { title: " Resume ", rationale: "Paused by mistake." }))).toEqual({
      title: "Resume",
      rationale: "Paused by mistake.",
      current: "",
      proposed: "setPaused(false)",
    });
  });

  it("requires a title and a rationale and keeps the brain's limits", () => {
    expect(() => caseURI(call, { title: "", rationale: "r" })).toThrow(/--title is required/);
    expect(() => caseURI(call, { title: "t", rationale: " " })).toThrow(/--rationale is required/);
    expect(() => caseURI(call, { title: "t".repeat(121), rationale: "r" })).toThrow(/--title is at most 120/);
  });
});

function fakeChain(overrides: Partial<ProposalChain> = {}): ProposalChain {
  return {
    account: ME,
    now: vi.fn(async () => 1_800_000_000n),
    ethBalance: vi.fn(async () => parseEther("0.001")),
    sent: vi.fn(async () => 2),
    stakeBalance: vi.fn(async () => parseEther("300000")),
    bond: vi.fn(async () => parseEther("250000")),
    decideWithin: vi.fn(async () => 604_800n),
    changeThresholdBps: vi.fn(async () => 6000n),
    timelock: vi.fn(async () => 172_800n),
    vetoed: vi.fn(async () => false),
    rehearse: vi.fn(async () => undefined),
    propose: vi.fn(async () => ({ id: 2n, tx: TX })),
    get: vi.fn(async (id: bigint) => ({ id, proposer: ME, bond: parseEther("250000"), createdAt: 1_799_990_000n, state: 1 })),
    outcome: vi.fn(async () => undefined),
    queued: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("propose", () => {
  const call = buildCall(MAINNET, ME, { target: "board", call: "setFee", args: `[300, "${ROUTER}"]` });

  async function run(chain: ProposalChain, dry = false) {
    const lines: string[] = [];
    await propose(MAINNET, chain, call, "data:application/json;base64,e30=", { dry, log: (line) => lines.push(line) });
    return lines;
  }

  it("bonds and proposes, then says how to follow it", async () => {
    const chain = fakeChain();
    const lines = await run(chain);
    expect(chain.propose).toHaveBeenCalledWith(call, "data:application/json;base64,e30=", parseEther("250000"));
    expect(lines[0]).toContain("Bond      250,000 BRAIN, returned if Jev adopts the change with at least 60% confidence, burned otherwise");
    expect(lines[0]).toContain("Decision  within 7 days; an adopted change runs 48 hours later");
    expect(lines.at(-1)).toBe(`Proposal 2 is waiting for Jev (${TX}). Follow it with \`npx brainchain-worker proposal 2\`.`);
  });

  it("sends nothing on a dry run, even without the bond", async () => {
    const chain = fakeChain({ stakeBalance: vi.fn(async () => 0n) });
    expect((await run(chain, true)).at(-1)).toBe("Dry run, nothing sent.");
    expect(chain.propose).not.toHaveBeenCalled();
  });

  it("refuses a call that would revert or was vetoed, before any bond moves", async () => {
    const reverting = fakeChain({ rehearse: vi.fn(async () => "BadFee, the contract's check on these values") });
    await expect(run(reverting)).rejects.toThrow(/would fail if the executor made it now \(BadFee/);
    const vetoed = fakeChain({ vetoed: vi.fn(async () => true) });
    await expect(run(vetoed)).rejects.toThrow(ProposalError);
    expect(reverting.propose).not.toHaveBeenCalled();
    expect(vetoed.propose).not.toHaveBeenCalled();
  });

  it("names a short bond and missing gas", async () => {
    await expect(run(fakeChain({ stakeBalance: vi.fn(async () => parseEther("1000")) }))).rejects.toThrow(/holds 1,000 BRAIN of the 250,000 BRAIN bond\. Buy BRAIN/);
    await expect(run(fakeChain({ ethBalance: vi.fn(async () => 0n) }))).rejects.toThrow(/no ETH on BrainChain for gas/);
  });
});

describe("proposal", () => {
  async function show(chain: ProposalChain, id = 2n) {
    const lines: string[] = [];
    await proposal(MAINNET, chain, id, (line) => lines.push(line));
    return lines.join("\n");
  }
  const head = `Proposal 2 by ${ME}, bond 250,000 BRAIN`;

  it("shows an open proposal's deadline, and that anyone can expire it once passed", async () => {
    expect(await show(fakeChain())).toBe(`${head}\n  Waiting for Jev: Jev decides by 2027-01-22T05:13:20Z.`);
    expect(await show(fakeChain({ now: vi.fn(async () => 1_900_000_000n) }))).toContain("anyone can return the bond with expire");
  });

  it("shows an adopted change and when it runs", async () => {
    const chain = fakeChain({
      get: vi.fn(async (id: bigint) => ({ id, proposer: ME, bond: parseEther("250000"), createdAt: 0n, state: 2 })),
      outcome: vi.fn(async () => ({ decisionId: 9n, adopted: true })),
      queued: vi.fn(async () => ({ changeId: 3n, eta: 1_800_172_800n, executed: false, vetoed: false })),
    });
    expect(await show(chain)).toBe(`${head}\n  Jev adopted it (decision 9) and the bond was returned; change 3 runs from 2027-01-17T08:00:00Z.`);
  });

  it("shows a kept setting, an expiry and a missing proposal", async () => {
    const burned = fakeChain({
      get: vi.fn(async (id: bigint) => ({ id, proposer: ME, bond: parseEther("250000"), createdAt: 0n, state: 3 })),
      outcome: vi.fn(async () => ({ decisionId: 4n, adopted: false })),
    });
    expect(await show(burned)).toContain("Jev kept the current setting (decision 4); the bond was burned.");
    const expired = fakeChain({
      get: vi.fn(async (id: bigint) => ({ id, proposer: ME, bond: parseEther("250000"), createdAt: 0n, state: 2 })),
      outcome: vi.fn(async () => "expired" as const),
    });
    expect(await show(expired)).toContain("Not decided in its window; the bond was returned.");
    const none = fakeChain({ get: vi.fn(async (id: bigint) => ({ id, proposer: ME, bond: 0n, createdAt: 0n, state: 0 })) });
    await expect(show(none)).rejects.toThrow("There is no proposal 2 on BrainChain");
  });
});
