import { describe, expect, it } from "vitest";

import { MAINNET, TESTNET } from "./network.js";
import { hireable, shortOfStake, wallet, type Snapshot } from "./standing.js";

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

describe("shortOfStake", () => {
  const buy =
    "Buy BRAIN on ripples.run (https://ripples.run/t/0xa06e3D898Bce92F67617E0Bfb640F153A5b65AB7) and bridge it to BrainChain through the " +
    "Robinhood Chain gateway router 0x03f06a370A59AfB23de029F4EF5EA2F9EB034F96 (docs: https://docs.usebrainchain.com/bridging); " +
    "the stake token on BrainChain is 0x3367085Eb6C79BfB0fCa4f1433ec77bFA8CB8a37.";

  it("tells a mainnet worker short of BRAIN where to buy it and how to bridge it", () => {
    expect(shortOfStake(MAINNET, standing().w, 100n * BRAIN, 1_250_000n * BRAIN, 1_000n)).toBe(`The wallet holds 100 BRAIN of the 1250000 BRAIN join needs. ${buy}`);
  });

  it("points to the stake that is unstaking", () => {
    const w = standing({ unstaking: 1_000_000n * BRAIN, unlocksAt: 2_000n }).w;
    expect(shortOfStake(MAINNET, w, 0n, 1_250_000n * BRAIN, 1_000n)).toBe(
      `The wallet holds 0 BRAIN of the 1250000 BRAIN join needs. ${buy} Or run withdraw after 1970-01-01T00:33:20Z and join with the 1000000 BRAIN it returns.`,
    );
    expect(shortOfStake(MAINNET, w, 0n, 1_250_000n * BRAIN, 2_000n)).toContain("Or run withdraw now and join");
  });
});
