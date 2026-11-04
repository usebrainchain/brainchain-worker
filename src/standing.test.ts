import { describe, expect, it, vi } from "vitest";

import { MAINNET, TESTNET } from "./network.js";
import { aboutEth, ethNeeded, gasLine, hireable, joinLimits, shortOfStake, stake, wallet, type Snapshot } from "./standing.js";

const BRAIN = 10n ** 18n;
const buy =
  "Buy BRAIN on Robinhood Chain at ripples.run (https://ripples.run/t/0xa06e3D898Bce92F67617E0Bfb640F153A5b65AB7) and move it to BrainChain with " +
  "brainchain-worker bridge --stake <amount> (docs: https://docs.usebrainchain.com/bridging); the stake token on BrainChain is 0x3367085Eb6C79BfB0fCa4f1433ec77bFA8CB8a37.";

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

describe("stake", () => {
  it("groups whole tokens in thousands and keeps a fraction as it is", () => {
    expect(stake(MAINNET, 1_000_000n * BRAIN)).toBe("1,000,000 BRAIN");
    expect(stake(MAINNET, 1_250_000n * BRAIN)).toBe("1,250,000 BRAIN");
    expect(stake(TESTNET, 500n * BRAIN)).toBe("500 tBRAIN");
    expect(stake(TESTNET, 1_000n * BRAIN + BRAIN / 4n)).toBe("1,000.25 tBRAIN");
    expect(stake(TESTNET, 0n)).toBe("0 tBRAIN");
  });
});

describe("wallet", () => {
  const now = 1_000n;

  it("says where join finds the stake token, from the faucet when it is open", () => {
    expect(wallet(TESTNET, standing(), 100n * BRAIN, 100n * BRAIN, { amount: 1_000n * BRAIN, opensAt: 0n }, now)).toBe(
      "100 tBRAIN; join needs 500 tBRAIN and claims the rest from the faucet, which gives 1,000 tBRAIN a day",
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

  it("tells a mainnet worker short of BRAIN where to buy it and how to bridge it", () => {
    const mainnet = (overrides: { staked?: bigint; unstaking?: bigint; unlocksAt?: bigint } = {}) =>
      ({ ...standing(overrides), allowed: false, applying: true, min: 1_000_000n * BRAIN, toStake: 1_000_000n * BRAIN - (overrides.staked ?? 0n) }) as Snapshot;
    expect(wallet(MAINNET, mainnet(), 0n, 250_000n * BRAIN, undefined, now)).toBe(`0 BRAIN; join needs 1,250,000 BRAIN. ${buy}`);
    expect(wallet(MAINNET, mainnet({ unstaking: 1_000_000n * BRAIN, unlocksAt: 900n }), 0n, 250_000n * BRAIN, undefined, now)).toBe(
      `0 BRAIN; join needs 1,250,000 BRAIN, and the 1,000,000 BRAIN unstaking can be withdrawn now. ${buy}`,
    );
    expect(wallet(MAINNET, mainnet(), 1_250_000n * BRAIN, 250_000n * BRAIN, undefined, now)).toBe("1,250,000 BRAIN, enough for the 1,250,000 BRAIN join needs");
  });
});

const GWEI_TENTH = 100_000_000n;

describe("join's gas", () => {
  const applying = { ...standing(), allowed: false, applying: true } as Snapshot;

  it("covers the whole of each send at 2.4 times the price, plus what the sends before it paid", () => {
    expect(ethNeeded([100_000n], GWEI_TENTH)).toBe(24_000_000_000_000n);
    // 100,000 paid at the price, then 200,000 covered at the cap.
    expect(ethNeeded([100_000n, 200_000n], GWEI_TENTH)).toBe(10_000_000_000_000n + 48_000_000_000_000n);
    // A cheap last send: the largest cover needed can come earlier.
    expect(ethNeeded([1_000_000n, 1n], GWEI_TENTH)).toBe(240_000_000_000_000n);
    expect(ethNeeded([], GWEI_TENTH)).toBe(0n);
  });

  it("counts only what join will send, and a new worker needs what a wallet funded with 0.00005 ETH lacks", () => {
    expect(aboutEth(ethNeeded(joinLimits(applying, true, false), GWEI_TENTH))).toBe("0.000088");
    expect(joinLimits(standing({ staked: 500n * BRAIN }), false, false)).toEqual([]);
    expect(joinLimits(standing({ staked: 500n * BRAIN }), false, true)).toHaveLength(1);
    expect(joinLimits(standing({ staked: 100n * BRAIN }), false, false)).toHaveLength(2);
  });

  it("rounds up to two figures", () => {
    expect(aboutEth(87_200_000_000_000n)).toBe("0.000088");
    expect(aboutEth(88_000_000_000_000n)).toBe("0.000088");
    expect(aboutEth(9n)).toBe("0.000000000000000009");
  });
});

describe("gasLine", () => {
  const applying = { ...standing(), allowed: false, applying: true } as Snapshot;
  const staked = standing({ staked: 500n * BRAIN });

  it("says what join needs when the wallet lacks it and join has something to do", () => {
    expect(gasLine(TESTNET, applying, 0n, GWEI_TENTH, true)).toBe(`0 ETH on BrainChain testnet; join needs about 0.000088 ETH for gas. ${TESTNET.gas}.`);
    expect(gasLine(MAINNET, applying, 20_000_000_000_000n, GWEI_TENTH, false)).toBe(`0.00002 ETH on BrainChain; join needs about 0.00008 ETH for gas. ${MAINNET.gas}.`);
    expect(gasLine(TESTNET, standing({ staked: 100n * BRAIN }), 0n, GWEI_TENTH, false)).toContain("join needs about 0.000034 ETH");
  });

  it("says what a delivery needs when join has nothing to do", () => {
    expect(gasLine(TESTNET, staked, 0n, GWEI_TENTH, false)).toBe(`0 ETH on BrainChain testnet; delivering a result needs about 0.000025 ETH for gas. ${TESTNET.gas}.`);
  });

  it("only gives the balance when the wallet has enough", () => {
    expect(gasLine(TESTNET, applying, 10n ** 15n, GWEI_TENTH, true)).toBe("0.001 ETH");
    expect(gasLine(TESTNET, staked, 10n ** 15n, GWEI_TENTH, false)).toBe("0.001 ETH");
  });
});

describe("hireable", () => {
  const allowedSoon = (eta: bigint, staked: bigint): Snapshot =>
    ({ ...standing({ staked }), allowed: false, change: { eta, executed: false, vetoed: false }, pending: true }) as unknown as Snapshot;

  it("points to status from run only", () => {
    const low = standing({ staked: 100n * BRAIN });
    expect(hireable(low, TESTNET, "run")).toBe("no: your stake is below the minimum of 500 tBRAIN. Run join to stake again; status shows what it needs.");
    expect(hireable(low, TESTNET, "status")).toBe("no: your stake is below the minimum of 500 tBRAIN. Run join to stake again.");
  });

  it("says when an allowed worker can be hired, and that its stake must come back first if it left", () => {
    vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
    try {
      const eta = BigInt(Date.parse("2026-11-04T10:58:18Z") / 1000);
      expect(hireable(allowedSoon(eta, 500n * BRAIN), TESTNET, "status")).toBe("no: Jev allowed this worker; it can be hired after 2026-11-04T10:58:18Z");
      expect(hireable(allowedSoon(eta, 0n), TESTNET, "status")).toBe(
        "no: Jev allowed this worker; it can be hired after 2026-11-04T10:58:18Z. Its stake is below the minimum of 500 tBRAIN, so run join to stake again first.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not promise a time already past while the change waits to run", () => {
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    try {
      const eta = BigInt(Date.parse("2026-11-04T10:58:18Z") / 1000);
      expect(hireable(allowedSoon(eta, 500n * BRAIN), TESTNET, "status")).toBe("no: Jev allowed this worker; the change that allows it was due at 2026-11-04T10:58:18Z and has not run yet");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shortOfStake", () => {
  it("tells a mainnet worker short of BRAIN where to buy it and how to bridge it", () => {
    expect(shortOfStake(MAINNET, standing().w, 100n * BRAIN, 1_250_000n * BRAIN, 1_000n)).toBe(`The wallet holds 100 BRAIN of the 1,250,000 BRAIN join needs. ${buy}`);
  });

  it("points to the stake that is unstaking", () => {
    const w = standing({ unstaking: 1_000_000n * BRAIN, unlocksAt: 2_000n }).w;
    expect(shortOfStake(MAINNET, w, 0n, 1_250_000n * BRAIN, 1_000n)).toBe(
      `The wallet holds 0 BRAIN of the 1,250,000 BRAIN join needs. ${buy} Or run withdraw after 1970-01-01T00:33:20Z and join with the 1,000,000 BRAIN it returns.`,
    );
    expect(shortOfStake(MAINNET, w, 0n, 1_250_000n * BRAIN, 2_000n)).toContain("Or run withdraw now and join");
  });
});
