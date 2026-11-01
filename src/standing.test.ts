import { describe, expect, it } from "vitest";

import { TESTNET } from "./network.js";
import { hireable, wallet, type Snapshot } from "./standing.js";

const BRAIN = 10n ** 18n;

function standing(overrides: { staked?: bigint; unstaking?: bigint; unlocksAt?: bigint } = {}): Snapshot {
  const w = { registered: true, staked: 0n, unstaking: 0n, unlocksAt: 0n, price: 200_000n, ...overrides };
  const min = 500n * BRAIN;
  return {
    allowed: true,
    w,
    min,
    applications: [],
    change: undefined,
    pending: false,
    open: undefined,
    applying: false,
    toStake: w.staked >= min ? 0n : min - w.staked,
  } as unknown as Snapshot;
}

describe("wallet", () => {
  const now = 1_000n;

  it("says where join finds the stake token, from the faucet when it is open", () => {
    expect(wallet(TESTNET, standing(), 100n * BRAIN, 100n * BRAIN, { amount: 1_000n * BRAIN, opensAt: 0n }, now)).toBe(
      "100 tBRAIN; join needs 500 tBRAIN and claims the rest from the faucet, which gives 1000 tBRAIN a day",
    );
    expect(wallet(TESTNET, standing(), 100n * BRAIN, 100n * BRAIN, { amount: 1_000n * BRAIN, opensAt: 2_000n }, now)).toBe(
      "100 tBRAIN; join needs 500 tBRAIN. The faucet opens again for this wallet at 1970-01-01T00:33:20Z",
    );
  });

  it("leaves the faucet out for a stake token that has none", () => {
    expect(wallet(TESTNET, standing(), 100n * BRAIN, 100n * BRAIN, undefined, now)).toBe("100 tBRAIN; join needs 500 tBRAIN");
    expect(wallet(TESTNET, standing({ unstaking: 500n * BRAIN, unlocksAt: 900n }), 0n, 100n * BRAIN, undefined, now)).toBe(
      "0 tBRAIN; join needs 500 tBRAIN, and the 500 tBRAIN unstaking can be withdrawn now",
    );
  });
});

describe("hireable", () => {
  it("points to status from run only", () => {
    const low = standing({ staked: 100n * BRAIN });
    expect(hireable(low, TESTNET, "run")).toBe("no: your stake is below the minimum of 500 tBRAIN. Run join to stake again; status shows what it needs.");
    expect(hireable(low, TESTNET, "status")).toBe("no: your stake is below the minimum of 500 tBRAIN. Run join to stake again.");
  });
});
