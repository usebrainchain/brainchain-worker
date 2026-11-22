import { describe, expect, it, vi } from "vitest";

import { Status, type Flight } from "./chain.js";
import { cli } from "./invoked.js";
import { MAINNET, TESTNET } from "./network.js";
import { aboutEth, deliveriesAfterJoin, deliveriesLeft, ethNeeded, flightLine, gasHelp, gasLine, hireable, joinLimits, lasted, money, shortOfStake, stake, unapplied, usdg, wallet, type Snapshot } from "./standing.js";

const BRAIN = 10n ** 18n;
const buy =
  `${cli("buy-stake")} buys what is missing with ETH or USDG on Robinhood Chain, through 0x, and offers to bridge it; ` +
  "or buy BRAIN on Robinhood Chain at ripples.run (https://ripples.run/t/0x8D7dAC20bc8e3E6C5ad0ca07A1F00a4Ecd4e35C9) and move it to BrainChain with " +
  `${cli("bridge --stake <amount>")} (docs: https://docs.usebrainchain.com/bridging); BRAIN is 0x42b96dbc55e79E930d866c1eE486A342366546BC on Robinhood Chain ` +
  "and 0x1d909E933A7743b29e13387fB34cB29608c3833F on BrainChain.";

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

describe("money", () => {
  it("states a dollar amount as the service states a price, with two decimals at least", () => {
    expect([0n, 900_000n, 5_000_000n, 1_250_000n, 125_000n, 4_999_999n].map(money)).toEqual(["0.00", "0.90", "5.00", "1.25", "0.125", "4.999999"]);
    expect(usdg(MAINNET, 900_000n)).toBe("0.90 USDG");
  });
});

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
  const WORKER = "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4";
  const applying = { ...standing(), allowed: false, applying: true } as Snapshot;
  const staked = standing({ staked: 500n * BRAIN });

  const FAUCET =
    "Get Robinhood Chain testnet ETH from https://faucet.testnet.chain.robinhood.com, which asks for a browser check and a Google account, " +
    `so a person claims it, and move it here with ${cli("bridge --eth 0.001")}`;

  it("says what join needs when the wallet lacks it and join has something to do", () => {
    expect(gasLine(TESTNET, WORKER, applying, 0n, GWEI_TENTH, true, 0)).toBe(`0 ETH on BrainChain testnet; join needs about 0.000088 ETH for gas. ${gasHelp(TESTNET, WORKER, 0n, 0)}.`);
    expect(gasLine(MAINNET, WORKER, applying, 20_000_000_000_000n, GWEI_TENTH, false, 0)).toBe(
      `0.00002 ETH on BrainChain; join needs about 0.00008 ETH for gas. Send this address ETH on Robinhood Chain, then move it here with ${cli("bridge --eth 0.001")}.`,
    );
    expect(gasLine(TESTNET, WORKER, standing({ staked: 100n * BRAIN }), 0n, GWEI_TENTH, false, 3)).toContain("join needs about 0.000034 ETH");
  });

  it("sends a wallet that has never sent anything to the gas drip with its own address first, then to the faucet and bridge", () => {
    const line = gasLine(TESTNET, WORKER, applying, 0n, GWEI_TENTH, true, 0);
    const drip = line.indexOf(`curl -X POST https://brain.testnet.usebrainchain.com/testnet/gas -H 'content-type: application/json' -d '{"address":"${WORKER}"}'`);
    expect(drip).toBeGreaterThan(0);
    expect(line).toContain("sends 0.0001 ETH, enough to join, once per address. After that, get Robinhood Chain testnet ETH from https://faucet.testnet.chain.robinhood.com");
    expect(line.indexOf("bridge --eth 0.001")).toBeGreaterThan(line.indexOf("https://faucet.testnet.chain.robinhood.com"));
    expect(gasLine(MAINNET, WORKER, applying, 0n, GWEI_TENTH, false, 0)).not.toContain("drip");
  });

  it("sends a wallet the drip has served, or would turn away, to the faucet and bridge only", () => {
    // Sent transactions: the drip paid for its join, so it answers 409 now.
    expect(gasHelp(TESTNET, WORKER, 0n, 6)).toBe(`${FAUCET}. The gas drip serves each address once`);
    // A drip's worth or more: the drip turns it away whatever it has sent.
    expect(gasHelp(TESTNET, WORKER, 100_000_000_000_000n, 0)).toBe(`${FAUCET}. The gas drip serves each address once`);
    expect(gasHelp(TESTNET, WORKER, 99_999_999_999_999n, 0)).toMatch(/^Ask the testnet gas drip first/);
  });

  it("says what a delivery needs when join has nothing to do", () => {
    expect(gasLine(TESTNET, WORKER, staked, 0n, GWEI_TENTH, false, 6)).toBe(
      `0 ETH on BrainChain testnet; delivering a result needs about 0.000025 ETH for gas. ${FAUCET}. The gas drip serves each address once.`,
    );
  });

  it("gives the balance when the wallet has enough, and how many results it delivers once joined", () => {
    // Joining comes out of the same ETH: the faucet claim, the stake and the application, 536,000 gas.
    expect(gasLine(TESTNET, WORKER, applying, 10n ** 15n, GWEI_TENTH, true, 0)).toBe("0.001 ETH, enough to join and then for about 89 deliveries at the current gas price");
    expect(deliveriesAfterJoin(applying, 10n ** 15n, GWEI_TENTH, true)).toBe(deliveriesLeft(10n ** 15n - 536_000n * GWEI_TENTH, GWEI_TENTH));
    expect(deliveriesAfterJoin(staked, 10n ** 15n, GWEI_TENTH)).toBe(deliveriesLeft(10n ** 15n, GWEI_TENTH));
    expect(gasLine(TESTNET, WORKER, staked, 10n ** 15n, GWEI_TENTH, false, 6)).toBe("0.001 ETH, enough for about 94 deliveries at the current gas price");
    // What a drip leaves after join, as measured on testnet.
    expect(gasLine(TESTNET, WORKER, staked, 51_081_600_000_000n, GWEI_TENTH, false, 6)).toBe("0.0000510816 ETH, enough for about 3 deliveries at the current gas price");
  });
});

describe("hireable", () => {
  const allowedSoon = (eta: bigint, staked: bigint): Snapshot =>
    ({ ...standing({ staked }), allowed: false, change: { eta, executed: false, vetoed: false }, pending: true }) as unknown as Snapshot;

  it("points to status from run only", () => {
    const low = standing({ staked: 100n * BRAIN });
    expect(hireable(low, TESTNET, "run")).toBe(`no: your stake is below the minimum of 500 tBRAIN. Run ${cli("join")} to stake again; ${cli("status")} shows what it needs.`);
    expect(hireable(low, TESTNET, "status")).toBe(`no: your stake is below the minimum of 500 tBRAIN. Run ${cli("join")} to stake again.`);
  });

  it("says when an allowed worker can be hired, and that its stake must come back first if it left", () => {
    vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
    try {
      const eta = BigInt(Date.parse("2026-11-04T10:58:18Z") / 1000);
      expect(hireable(allowedSoon(eta, 500n * BRAIN), TESTNET, "status")).toBe("no: BrainChain allowed this worker; it can be hired after 2026-11-04T10:58:18Z");
      expect(hireable(allowedSoon(eta, 0n), TESTNET, "status")).toBe(
        `no: BrainChain allowed this worker; it can be hired after 2026-11-04T10:58:18Z. Its stake is below the minimum of 500 tBRAIN, so run ${cli("join")} to stake again first.`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("with an application waiting", () => {
    const filed = BigInt(Date.parse("2026-11-16T14:00:00Z") / 1000);
    const open = { ...standing(), allowed: false, applying: false, applications: [{ id: 70n, state: 1, createdAt: filed, decisionId: undefined }] } as unknown as Snapshot;
    const at = (time: string) => {
      vi.setSystemTime(new Date(time));
      try {
        return hireable(open, TESTNET, "status");
      } finally {
        vi.useRealTimers();
      }
    };

    it("says how long it has waited for BrainChain and where to look if it runs long", () => {
      expect(at("2026-11-16T14:25:30Z")).toBe(
        "no: application 70 has waited 25 minutes for BrainChain's decision (since 2026-11-16T14:00:00Z). It usually takes a few minutes; " +
          "if it takes more than an hour, check https://brain.testnet.usebrainchain.com/health or write to hello@usebrainchain.com.",
      );
      expect(at("2026-11-16T17:10:00Z")).toBe(
        "no: application 70 has waited 3 hours 10 minutes for BrainChain's decision (since 2026-11-16T14:00:00Z), longer than the few minutes it usually takes. " +
          "Check https://brain.testnet.usebrainchain.com/health, and if the service answers, write to hello@usebrainchain.com with the application's number.",
      );
    });

    it("gives run a line that stays the same while nothing changes, since run logs each new one", () => {
      const line = hireable(open, TESTNET, "run");
      expect(line).toBe(
        "no: application 70 has waited for BrainChain's decision since 2026-11-16T14:00:00Z. It usually takes a few minutes; " +
          "if it takes more than an hour, check https://brain.testnet.usebrainchain.com/health or write to hello@usebrainchain.com.",
      );
      vi.setSystemTime(Date.now() + 600_000);
      try {
        expect(hireable(open, TESTNET, "run")).toBe(line);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not promise a time already past while the change waits to run", () => {
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    try {
      const eta = BigInt(Date.parse("2026-11-04T10:58:18Z") / 1000);
      expect(hireable(allowedSoon(eta, 500n * BRAIN), TESTNET, "status")).toBe("no: BrainChain allowed this worker; the change that allows it was due at 2026-11-04T10:58:18Z and has not run yet");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("unapplied", () => {
  const fresh = { ...standing(), allowed: false, applying: true } as unknown as Snapshot;

  it("is a worker that never applied, staked or not, with nothing of its own in flight", () => {
    expect(unapplied(fresh, 0)).toBe(true);
    expect(unapplied({ ...fresh, w: { ...fresh.w, staked: 500n * BRAIN }, toStake: 0n } as Snapshot, 0)).toBe(true);
  });

  it("is not a worker that is allowed, about to be, has applied, or still has a task to finish", () => {
    expect(unapplied(standing(), 0)).toBe(false);
    expect(unapplied({ ...fresh, pending: true } as Snapshot, 0)).toBe(false);
    expect(unapplied({ ...fresh, applications: [{ id: 3n, state: 3, createdAt: 0n, decisionId: 9n }] } as unknown as Snapshot, 0)).toBe(false);
    expect(unapplied(fresh, 1)).toBe(false);
  });
});

describe("lasted", () => {
  it("gives a length of time in its largest two units", () => {
    expect(lasted(0n)).toBe("less than a minute");
    expect(lasted(59n)).toBe("less than a minute");
    expect(lasted(60n)).toBe("1 minute");
    expect(lasted(25n * 60n + 30n)).toBe("25 minutes");
    expect(lasted(3_900n)).toBe("1 hour 5 minutes");
    expect(lasted(2n * 86_400n + 3n * 3_600n + 120n)).toBe("2 days 3 hours");
    expect(lasted(2n * 86_400n + 120n)).toBe("2 days");
  });
});

describe("shortOfStake", () => {
  it("tells a mainnet worker short of BRAIN where to buy it and how to bridge it", () => {
    expect(shortOfStake(MAINNET, standing().w, 100n * BRAIN, 1_250_000n * BRAIN, 1_000n)).toBe(`The wallet holds 100 BRAIN of the 1,250,000 BRAIN join needs. ${buy}`);
  });

  it("points to the stake that is unstaking", () => {
    const w = standing({ unstaking: 1_000_000n * BRAIN, unlocksAt: 2_000n }).w;
    expect(shortOfStake(MAINNET, w, 0n, 1_250_000n * BRAIN, 1_000n)).toBe(
      `The wallet holds 0 BRAIN of the 1,250,000 BRAIN join needs. ${buy} Or run ${cli("withdraw")} after 1970-01-01T00:33:20Z and join with the 1,000,000 BRAIN it returns.`,
    );
    expect(shortOfStake(MAINNET, w, 0n, 1_250_000n * BRAIN, 2_000n)).toContain(`Or run ${cli("withdraw")} now and join`);
  });
});

describe("flightLine", () => {
  // Two real tasks, 45 and 46, read at each step.
  const GRADED = 1_793_806_740n;
  const flight = (overrides: Partial<Flight>): Flight => ({
    id: 45n,
    status: Status.Graded,
    accepted: true,
    disputedByModel: false,
    deadline: 1_793_828_281n,
    gradedAt: GRADED,
    disputedAt: 0n,
    disputeWindow: 3_600n,
    ruleWindow: 21_600n,
    ...overrides,
  });

  it("says an accepted task is paid after its dispute window, unless the grade is disputed", () => {
    expect(flightLine(flight({}))).toBe("task 45: accepted, paid after 2026-11-04T16:39:00Z unless the grade is disputed");
  });

  it("says a rejected task can still be disputed, and an open dispute when BrainChain rules", () => {
    expect(flightLine(flight({ id: 46n, accepted: false }))).toBe(
      `task 46: not accepted, refunded to the poster after 2026-11-04T16:39:00Z unless the grade is disputed with ${cli("dispute 46")}`,
    );
    expect(flightLine(flight({ id: 46n, status: Status.Disputed, accepted: false, disputedByModel: true, disputedAt: GRADED + 600n }))).toBe(
      "task 46: grade disputed by this worker, BrainChain rules by 2026-11-04T21:49:00Z",
    );
    expect(flightLine(flight({ id: 46n, status: Status.Disputed, disputedAt: GRADED + 600n }))).toBe("task 46: grade disputed by the poster, BrainChain rules by 2026-11-04T21:49:00Z");
  });

  it("says what a ruling does and until when it can be appealed", () => {
    const appeal = { window: 3_600n, ruledAt: GRADED + 700n, pays: false, appealedAt: 0n };
    expect(flightLine(flight({ id: 46n, status: Status.Ruled, appeal }))).toBe(`task 46: the ruling refunds the poster after 2026-11-04T16:50:40Z unless appealed with ${cli("appeal 46")}`);
    expect(flightLine(flight({ id: 46n, status: Status.Ruled, appeal: { ...appeal, pays: true } }))).toBe(
      "task 46: the ruling pays this worker after 2026-11-04T16:50:40Z unless the poster appeals",
    );
    expect(flightLine(flight({ id: 46n, status: Status.Appealed, appeal: { ...appeal, appealedAt: GRADED + 800n } }))).toBe(
      "task 46: ruling appealed, BrainChain rules again by 2026-11-04T21:52:20Z",
    );
  });

  it("says a hired task's deadline and that a delivered one waits for its grade", () => {
    expect(flightLine(flight({ status: Status.Hired }))).toBe("task 45: hired, due by 2026-11-04T21:38:01Z");
    expect(flightLine(flight({ status: Status.Submitted }))).toBe("task 45: delivered, waiting for BrainChain's grade");
  });
});

describe("deliveriesLeft", () => {
  it("counts the results the ETH delivers, the last at the fee cap the RPC checks", () => {
    const each = 104_000n * GWEI_TENTH;
    expect(deliveriesLeft(0n, GWEI_TENTH)).toBe(0n);
    expect(deliveriesLeft((each * 24n) / 10n - 1n, GWEI_TENTH)).toBe(0n);
    expect(deliveriesLeft((each * 24n) / 10n, GWEI_TENTH)).toBe(1n);
    expect(deliveriesLeft((each * 24n) / 10n + each, GWEI_TENTH)).toBe(2n);
  });
});
