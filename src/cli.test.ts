import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { Chain } from "./chain.js";
import { asksHelp, join, main, parse, usage, UsageError, watching } from "./cli.js";
import { MAINNET, TESTNET, type Network } from "./network.js";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000C1";
const BRAIN = 10n ** 18n;

describe("parse", () => {
  it("refuses a value on a switch", () => {
    for (const [command, args, flag] of [
      ["claim", ["--dry=1"], "dry"],
      ["mint", ["--dry="], "dry"],
      ["run", ["--exec", "wc -w", "--no-mint=false"], "no-mint"],
      ["run", ["--once=x"], "once"],
    ] as const) {
      expect(() => parse(command, [...args])).toThrow(new UsageError(`--${flag} takes no value`));
    }
  });

  it("still takes switches bare and values inline", () => {
    const { values, switches } = parse("mint", ["--count=3", "--dry"]);
    expect(values.get("count")).toBe("3");
    expect([...switches]).toEqual(["dry"]);
  });
});

describe("help", () => {
  const COMMANDS = ["new-key", "join", "run", "status", "price", "mint", "claim", "bridge", "propose", "proposal", "watch", "credit", "dispute", "appeal", "leave", "withdraw"];

  async function printed(argv: string[]): Promise<string> {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await main(argv);
      return log.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      log.mockRestore();
    }
  }

  it("counts -h and --help as a flag of their own, in any position", () => {
    for (const [command, args] of [
      ["price", ["--help"]],
      ["price", ["-h"]],
      ["price", ["0.25", "--help"]],
      ["join", ["--name", "Atlas", "-h"]],
      ["join", ["--name=Atlas", "--help"]],
      ["watch", ["--once", "-h"]],
      ["run", ["--exec", "--help"]],
      ["run", ["--bogus", "-h"]],
      ["new-key", ["-h"]],
    ] as const) {
      expect(asksHelp(command, [...args])).toBe(true);
    }
  });

  it("leaves -h and --help alone as the value of another flag", () => {
    for (const [command, args] of [
      ["join", ["--name", "Atlas", "--about", "-h"]],
      ["join", ["--about=-h"]],
      ["join", ["--about=--help"]],
      ["run", ["--exec", "cat", "--timeout", "-h"]],
      ["propose", ["--title", "-h", "--rationale", "-h"]],
    ] as const) {
      expect(asksHelp(command, [...args])).toBe(false);
    }
    expect(parse("join", ["--about", "-h"]).values.get("about")).toBe("-h");
  });

  it("sends a flag's -h on to be validated instead of printing help", async () => {
    vi.stubEnv("BRAINCHAIN_WORKER_KEY", `0x${"4f".repeat(32)}`);
    try {
      const refused = main(["run", "--exec", "cat", "--timeout", "-h"]);
      await expect(refused).rejects.toBeInstanceOf(UsageError);
      await expect(refused).rejects.toThrow("--timeout is the most minutes");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("prints only the command's own lines for each command", async () => {
    for (const command of COMMANDS) {
      for (const argv of [[command, "--help"], [command, "-h"], ["help", command], ["--help", command]]) {
        const text = await printed(argv);
        expect(text).toBe(usage(command));
        expect(text.startsWith(`Usage:\n  brainchain-worker ${command}`)).toBe(true);
        expect(text.match(/^ {2}brainchain-worker /gm)).toHaveLength(1);
      }
    }
    expect(await printed(["new-key", "--help"])).not.toContain("BRAINCHAIN_WORKER_KEY=");
  });

  it("prints everything with no command, or a name that is not a command", async () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"], ["nonsense", "--help"], ["constructor", "--help"], ["--version", "-h"], ["help", "nonsense"]]) {
      expect(await printed(argv)).toBe(usage(undefined));
    }
    const all = usage(undefined);
    for (const command of COMMANDS) expect(all).toContain(`  brainchain-worker ${command}`);
    expect(all).toContain("Environment:");
  });
});

describe("watching", () => {
  it("names no address without a key", () => {
    expect(watching(TESTNET, undefined, false)).toBe(`watching ${TESTNET.name} (read-only, no key)`);
  });

  it("names the worker with a key", () => {
    expect(watching(TESTNET, ACCOUNT, false)).toBe(`watching ${TESTNET.name} as ${ACCOUNT}, reporting rounds to the service`);
    expect(watching(TESTNET, ACCOUNT, true)).toBe(`watching ${TESTNET.name} as ${ACCOUNT}, vetoing through the guardian gate, reporting rounds to the service`);
  });
});

function fakeChain(gas: bigint, balance: bigint) {
  const send = () => vi.fn(async () => undefined);
  return {
    account: ACCOUNT,
    ethBalance: vi.fn(async () => gas),
    allowed: vi.fn(async () => false),
    stake: vi.fn(async () => ({ registered: false, staked: 0n, unstaking: 0n, unlocksAt: 0n, price: 0n })),
    minStake: vi.fn(async () => 1_000_000n * BRAIN),
    applications: vi.fn(async () => ({ applications: [], change: undefined })),
    bond: vi.fn(async () => 250_000n * BRAIN),
    stakeBalance: vi.fn(async () => balance),
    timelock: vi.fn(async () => 172_800n),
    now: vi.fn(async () => 1_000n),
    faucet: vi.fn(async () => ({ amount: 1_000n * BRAIN, opensAt: 0n })),
    claimStakeToken: send(),
    approve: send(),
    stakeTokens: send(),
    setPrice: send(),
    apply: send(),
    holdsAgent: vi.fn(async () => true as boolean | undefined),
  };
}

async function joinError(chain: ReturnType<typeof fakeChain>, network: Network): Promise<string> {
  const values = new Map([
    ["name", "Atlas"],
    ["about", "Summaries"],
  ]);
  const error = await join(chain as unknown as Chain, network, values).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof Error)) throw new Error("join did not fail");
  for (const send of [chain.claimStakeToken, chain.approve, chain.stakeTokens, chain.setPrice, chain.apply]) expect(send).not.toHaveBeenCalled();
  return error.message;
}

describe("join", () => {
  const withId = (id: string) =>
    new Map([
      ["name", "Atlas"],
      ["about", "Summaries"],
      ["agent-id", id],
    ]);

  it("applies with the ERC-8004 agent id in the profile", async () => {
    const chain = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await join(chain as unknown as Chain, MAINNET, withId("501"));
    } finally {
      log.mockRestore();
    }
    const uri = (chain.apply.mock.calls[0] as unknown as [string])[0];
    expect(JSON.parse(Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString())).toEqual({ name: "Atlas", about: "Summaries", agentId: 501 });
  });

  it("refuses an agent id before any transaction: past the application, not held by the wallet, on testnet, or not a whole number", async () => {
    const allowed = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
    allowed.allowed.mockResolvedValue(true);
    allowed.stake.mockResolvedValue({ registered: true, staked: 1_000_000n * BRAIN, unstaking: 0n, unlocksAt: 0n, price: 200_000n });
    await expect(join(allowed as unknown as Chain, MAINNET, withId("501"))).rejects.toThrow(/already allowed or has one waiting/);
    const stranger = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
    stranger.holdsAgent.mockResolvedValue(false);
    await expect(join(stranger as unknown as Chain, MAINNET, withId("502"))).rejects.toThrow(/neither owns ERC-8004 agent 502/);
    await expect(join(fakeChain(10n ** 15n, 2_000_000n * BRAIN) as unknown as Chain, TESTNET, withId("502"))).rejects.toThrow(/mainnet only/);
    await expect(join(fakeChain(10n ** 15n, 2_000_000n * BRAIN) as unknown as Chain, MAINNET, withId("abc"))).rejects.toThrow(UsageError);
    for (const chain of [allowed, stranger]) for (const send of [chain.approve, chain.stakeTokens, chain.setPrice, chain.apply]) expect(send).not.toHaveBeenCalled();
  });

  const gas = `${ACCOUNT} has no ETH on BrainChain for gas. Bridge some from Robinhood Chain at https://usebrainchain.com/network; 0.001 ETH is plenty.`;
  const short = `The wallet holds 0 BRAIN of the 1,250,000 BRAIN join needs. ${MAINNET.buyStake}`;

  it("tells a new mainnet worker with no ETH and no BRAIN both needs at once", async () => {
    expect(await joinError(fakeChain(0n, 0n), MAINNET)).toBe(`${gas}\n${short}`);
  });

  it("names only the need a mainnet worker has", async () => {
    expect(await joinError(fakeChain(0n, 1_250_000n * BRAIN), MAINNET)).toBe(gas);
    expect(await joinError(fakeChain(10n ** 15n, 0n), MAINNET)).toBe(short);
  });

  it("names only gas on testnet, where the faucet covers the stake", async () => {
    const chain = fakeChain(0n, 0n);
    expect(await joinError(chain, TESTNET)).toBe(
      `${ACCOUNT} has no ETH on BrainChain testnet for gas. ${TESTNET.gas}; 0.001 ETH is plenty.`,
    );
    expect(chain.stake).not.toHaveBeenCalled();
  });
});
