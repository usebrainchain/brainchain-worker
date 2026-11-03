import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { Status } from "./chain.js";
import { appeal, Appealed, dispute, Ruled, type DisputeChain, type DisputeTask } from "./dispute.js";
import { TESTNET } from "./network.js";

const WORKER = "0x00000000000000000000000000000000000000c1" as Address;
const POSTER = "0x00000000000000000000000000000000000000a1" as Address;
const NOW = 1_800_000_000n;
const TX = `0x${"ab".repeat(32)}` as Hex;

function fake(task: Partial<DisputeTask>, terms = { window: 3_600n, ruledAt: NOW - 60n, pays: false }, balance = 10_000_000n) {
  const chain = {
    account: WORKER,
    now: vi.fn(async () => NOW),
    task: vi.fn(async () => ({
      status: Status.Graded,
      poster: POSTER,
      payee: WORKER,
      accepted: false,
      disputed: false,
      gradedAt: NOW - 60n,
      disputeWindow: 3_600n,
      ruleWindow: 21_600n,
      ...task,
    })),
    appealOf: vi.fn(async () => terms),
    appealBond: vi.fn(async () => 1_250_000n),
    bountyBalance: vi.fn(async () => balance),
    approveBounty: vi.fn(async () => undefined),
    dispute: vi.fn(async () => TX),
    appeal: vi.fn(async () => TX),
  } satisfies DisputeChain;
  return chain;
}

describe("dispute", () => {
  it("disputes a grade on work the worker delivered, inside the window", async () => {
    const chain = fake({});
    const lines: string[] = [];
    await dispute(TESTNET, chain, 7n, (l) => lines.push(l));
    expect(chain.dispute).toHaveBeenCalledWith(7n);
    expect(lines[0]).toBe(`Disputed the grade on task 7 (it rejected the work): ${TX}`);
  });

  it("refuses a stranger, a second dispute, an ungraded task and a closed window", async () => {
    await expect(dispute(TESTNET, fake({ payee: POSTER }), 7n, () => {})).rejects.toThrow("is neither");
    await expect(dispute(TESTNET, fake({ disputed: true }), 7n, () => {})).rejects.toThrow("not waiting on a dispute");
    await expect(dispute(TESTNET, fake({ status: Status.Submitted }), 7n, () => {})).rejects.toThrow("not waiting on a dispute");
    await expect(dispute(TESTNET, fake({ gradedAt: NOW - 3_601n }), 7n, () => {})).rejects.toThrow("closed at");
    await expect(dispute(TESTNET, fake({ status: 0 }), 7n, () => {})).rejects.toThrow("There is no task 7");
  });
});

describe("appeal", () => {
  it("approves the bond and appeals a ruling that went against the worker", async () => {
    const chain = fake({ status: Ruled });
    const lines: string[] = [];
    await appeal(TESTNET, chain, 7n, (l) => lines.push(l));
    expect(chain.approveBounty).toHaveBeenCalledWith(1_250_000n);
    expect(chain.appeal).toHaveBeenCalledWith(7n);
    expect(lines[0]).toBe(`Appealed the ruling on task 7 with a 1.25 tUSDG bond: ${TX}`);
  });

  it("leaves the appeal to the poster when the ruling pays the worker", async () => {
    const chain = fake({ status: Ruled }, { window: 3_600n, ruledAt: NOW - 60n, pays: true });
    await expect(appeal(TESTNET, chain, 7n, () => {})).rejects.toThrow("pays the model, so only the poster");
    expect(chain.appeal).not.toHaveBeenCalled();
  });

  it("says why a task cannot be appealed", async () => {
    await expect(appeal(TESTNET, fake({ status: Status.Disputed }), 7n, () => {})).rejects.toThrow("still waiting for Jev's ruling");
    await expect(appeal(TESTNET, fake({ status: Appealed }), 7n, () => {})).rejects.toThrow("already under appeal");
    await expect(appeal(TESTNET, fake({ status: Status.Paid }), 7n, () => {})).rejects.toThrow("no ruling open to appeal");
    await expect(appeal(TESTNET, fake({ status: Ruled }, { window: 3_600n, ruledAt: NOW - 3_601n, pays: false }), 7n, () => {})).rejects.toThrow("closed at");
  });

  it("refuses before approving when the worker cannot cover the bond", async () => {
    const chain = fake({ status: Ruled }, undefined, 1_000_000n);
    await expect(appeal(TESTNET, chain, 7n, () => {})).rejects.toThrow("The appeal bond is 1.25 tUSDG, and the worker holds 1.");
    expect(chain.approveBounty).not.toHaveBeenCalled();
  });
});
