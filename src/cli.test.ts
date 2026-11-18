import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseEther, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { Chain } from "./chain.js";
import { asksHelp, bondArgs, fetchRecord, hireWatch, join, main, parse, timedLog, usage, UsageError, watching, watchPlace, watchResume } from "./cli.js";
import { CLI, cli, commandName } from "./invoked.js";
import { MAINNET, TESTNET, type Network } from "./network.js";
import { gasHelp, whereToBuy } from "./standing.js";
import { readWatched, writeWatched } from "./state.js";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000C1";
const BRAIN = 10n ** 18n;

describe("parse", () => {
  it("refuses a value on a switch", () => {
    for (const [command, args, flag] of [
      ["claim", ["--dry=1"], "dry"],
      ["mint", ["--dry="], "dry"],
      ["run", ["--exec", "wc -w", "--mint=false"], "mint"],
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
    // Accepted from before minting became opt-in, and changes nothing.
    expect(parse("run", ["--exec", "wc -w", "--no-mint"]).switches).toEqual(new Set(["no-mint"]));
  });
});

describe("bondArgs", () => {
  it("reads a task and an amount, or status and claim with a task, and refuses the rest", () => {
    expect(bondArgs(["12", "5"])).toEqual({ action: "bond", task: 12n, amount: 5_000_000n });
    expect(bondArgs(["12", "2.5"])).toEqual({ action: "bond", task: 12n, amount: 2_500_000n });
    expect(bondArgs(["status", "12"])).toEqual({ action: "status", task: 12n });
    expect(bondArgs(["claim", "12"])).toEqual({ action: "claim", task: 12n });
    expect(parse("bond", ["12", "5", "--yes"])).toEqual({ positional: ["12", "5"], values: new Map(), switches: new Set(["yes"]) });
    for (const [args, error] of [
      [[], `Usage: ${CLI} bond <task> <USDG>`],
      [["0", "5"], `Usage: ${CLI} bond <task> <USDG>`],
      [["12"], "The amount is in USDG"],
      [["12", "0"], "The amount is in USDG"],
      [["12", "1.2345678"], "The amount is in USDG"],
      [["status"], `Usage: ${CLI} bond status <task>`],
      [["claim", "x"], `Usage: ${CLI} bond claim <task>`],
    ] as const) {
      expect(() => bondArgs([...args])).toThrow(error);
    }
    expect(() => parse("bond", ["12", "5", "6"])).toThrow(UsageError);
  });
});

describe("help", () => {
  const COMMANDS = ["new-key", "join", "run", "status", "price", "mint", "claim", "bond", "bridge", "buy-stake", "propose", "proposal", "watch", "credit", "exam", "licence", "papers", "dispute", "appeal", "leave", "withdraw"];

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

  it("names a mistake in the command line before a missing key", async () => {
    for (const name of ["BRAINCHAIN_WORKER_KEY", "BRAINCHAIN_WORKER_KEY_FILE", "BRAINCHAIN_NETWORK", "BRAINCHAIN_RPC_URL"]) vi.stubEnv(name, "");
    try {
      const refusals: [string[], string][] = [
        [["run", "--exec", "cat", "--timeout", "0"], "--timeout is the most minutes"],
        [["run", "--exec", "cat", "--format", "xml"], "--format is prompt or json"],
        [["exit", "--to-solana", "nope"], '"nope" is not the address of a Solana wallet'],
        [["dispute", "x"], `Usage: ${CLI} dispute <task>`],
        [["price"], `Usage: ${CLI} price <USDG>`],
        [["price", "lots"], "The price must be a number"],
        [["exam"], `Usage: ${CLI} exam info, exam sit --agent-id <id>, exam submit --sitting <id> --item <n> --file <path>, or exam status`],
        [["exam", "resit"], `Usage: ${CLI} exam info`],
        [["exam", "info", "--dry"], `exam info has no --dry flag (see ${CLI} exam --help)`],
        [["exam", "status", "--agent-id", "5"], "exam status has no --agent-id flag"],
        [["exam", "sit"], "exam sit needs --agent-id: the agent's ERC-8004 id, a whole number"],
        [["exam", "sit", "--agent-id", "0x5"], '--agent-id is a whole number, the agent\'s ERC-8004 id, not "0x5"'],
        [["exam", "sit", "--agent-id", "5", "--class", "Code"], "--class is one of the classes"],
        [["exam", "sit", "--agent-id", "5", "--max-price", "0"], "--max-price is the most the sitting may cost: USDG above zero with at most 6 decimals, such as --max-price 5"],
        [["exam", "sit", "--agent-id", "5", "--max-price", "5.1234567"], "--max-price is the most the sitting may cost"],
        [["exam", "sit", "--agent-id", "5", "--format", "json"], "--format and --timeout say how --exec is run, so they need it"],
        [["exam", "sit", "--agent-id", "5", "--exec", "cat", "--timeout", "0"], "--timeout is the most minutes"],
        [["exam", "submit", "--item", "1"], "exam submit needs --sitting: the sitting's id, as exam sit printed it"],
        [["exam", "submit", "--sitting", `0x${"5a".repeat(32)}`, "--item", "12"], "exam submit needs --item: the item's number in the sitting, from 0"],
        [["exam", "status", "--sitting", "0x12"], "--sitting is the sitting's id as exam sit printed it: 0x and 64 hex characters"],
        [["licence"], "licence needs --agent-id: the agent's ERC-8004 id, a whole number"],
        [["license"], "licence needs --agent-id"],
        [["papers", "--agent-id", "-1"], '--agent-id is a whole number, the agent\'s ERC-8004 id, not "-1"'],
      ];
      for (const [argv, said] of refusals) await expect(main(argv), argv.join(" ")).rejects.toThrow(said);
      await expect(main(["run", "--exec", "cat"])).rejects.toThrow("Set BRAINCHAIN_WORKER_KEY");
      for (const argv of [["exam", "sit", "--agent-id", "5"], ["exam", "status"]]) await expect(main(argv), argv.join(" ")).rejects.toThrow("Set BRAINCHAIN_WORKER_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("takes license for licence, in a command and in its help", async () => {
    expect(usage("license")).toBe(usage("licence"));
    for (const argv of [["license", "--help"], ["help", "license"]]) expect(await printed(argv)).toBe(usage("licence"));
    expect(parse("licence", ["--agent-id", "501"]).values.get("agent-id")).toBe("501");
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

  it("ends each command's own lines with an example of it", () => {
    for (const command of [...COMMANDS, "exit", "fund"]) {
      const example = usage(command).split("\n").at(-1)!;
      expect(example).toMatch(new RegExp(`^Example: (BRAINCHAIN_NETWORK=mainnet )?brainchain-worker ${command}( |$)`));
      // The words as the shell would pass them, so a flag the command does not take shows here.
      const words = [...example.matchAll(/'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g)].map(([, single, double, bare]) => single ?? (double === undefined ? bare! : double.replace(/\\(.)/g, "$1")));
      const args = words.slice(words.indexOf(command) + 1);
      expect(() => parse(command, args), example).not.toThrow();
    }
    expect(usage(undefined)).not.toContain("Example:");
  });

  it("says what run --once and watch --once exit with, and that a pipe can hold the key", () => {
    expect(usage("run").replace(/\s+/g, " ")).toContain("--once does one pass and exits 0, or 1 when a task failed or was left too close to its deadline, or the chain could not be read");
    expect(usage("watch").replace(/\s+/g, " ")).toContain("It exits 0 when all is well, and 1 on a finding or when a decision could not be checked or reported");
    expect(usage(undefined).replace(/\s+/g, " ")).toContain("BRAINCHAIN_WORKER_KEY_FILE A file or a pipe that holds only the key");
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

function fakeChain(gas: bigint, balance: bigint, sent = 0) {
  const send = () => vi.fn(async () => undefined);
  return {
    account: ACCOUNT,
    ethBalance: vi.fn(async () => gas),
    sent: vi.fn(async () => sent),
    gasPrice: vi.fn(async () => 100_000_000n),
    allowed: vi.fn(async () => false),
    stake: vi.fn(async () => ({ registered: false, staked: 0n, unstaking: 0n, unlocksAt: 0n, price: 0n })),
    retiredStakes: vi.fn(async () => []),
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
    applicationVetoed: vi.fn(async () => false),
    openApplication: vi.fn(async () => 0n),
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

  const gas = (holds: string, need: string, network: Network = MAINNET) =>
    `${ACCOUNT} holds ${holds} ETH on ${network.name}; join needs about ${need} ETH for gas. ${gasHelp(network, ACCOUNT, parseEther(holds), 0)}.`;
  const short = `The wallet holds 0 BRAIN of the 1,250,000 BRAIN join needs. ${whereToBuy(MAINNET)}`;

  it("tells a new mainnet worker with no ETH and no BRAIN both needs at once", async () => {
    expect(await joinError(fakeChain(0n, 0n), MAINNET)).toBe(`${gas("0", "0.00008")}\n${short}`);
  });

  it("names only the need a mainnet worker has", async () => {
    expect(await joinError(fakeChain(0n, 1_250_000n * BRAIN), MAINNET)).toBe(gas("0", "0.00008"));
    expect(await joinError(fakeChain(10n ** 15n, 0n), MAINNET)).toBe(short);
  });

  it("names only gas on testnet, where the faucet covers the stake", async () => {
    expect(await joinError(fakeChain(0n, 0n), TESTNET)).toBe(gas("0", "0.000088", TESTNET));
  });

  it("sends a wallet that has sent transactions, as one the drip paid for has, to the faucet and the bridge", async () => {
    // A worker that joined on its drip, then left or was slashed, joins again.
    const error = await joinError(fakeChain(20_000_000_000_000n, 0n, 6), TESTNET);
    expect(error).toBe(
      `${ACCOUNT} holds 0.00002 ETH on BrainChain testnet; join needs about 0.000088 ETH for gas. ` +
        "Get Robinhood Chain testnet ETH from https://faucet.testnet.chain.robinhood.com, which asks for a browser check and a Google account, " +
        `so a person claims it, and move it here with ${cli("bridge --eth 0.001")}. The gas drip serves each address once.`,
    );
  });

  it("refuses a wallet with some ETH but not enough, before anything is sent", async () => {
    expect(await joinError(fakeChain(20_000_000_000_000n, 0n), TESTNET)).toBe(gas("0.00002", "0.000088", TESTNET));
    // The figure the docs used to give for joining: what join spends, which is less than a wallet must hold to start.
    expect(await joinError(fakeChain(50_000_000_000_000n, 0n), TESTNET)).toBe(gas("0.00005", "0.000088", TESTNET));
  });

  it("goes through with the amount it names", async () => {
    const chain = fakeChain(88_000_000_000_000n, 0n);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await join(chain as unknown as Chain, TESTNET, new Map([["name", "Atlas"], ["about", "Summaries"]]));
    } finally {
      log.mockRestore();
    }
    expect(chain.apply).toHaveBeenCalledOnce();
  });

  it("prints the hash of each transaction it sends, under its step, and none for an approval it did not need", async () => {
    const chain = fakeChain(88_000_000_000_000n, 0n);
    const hash = (n: number) => `0x${String(n).repeat(64)}` as const;
    chain.claimStakeToken.mockResolvedValue(hash(1) as never);
    chain.approve.mockResolvedValueOnce(hash(2) as never).mockResolvedValueOnce(undefined);
    chain.stakeTokens.mockResolvedValue(hash(3) as never);
    chain.apply.mockResolvedValue(hash(4) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await join(chain as unknown as Chain, TESTNET, new Map([["name", "Atlas"], ["about", "Summaries"]]));
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines.slice(0, 6)).toEqual([
        "Claiming tBRAIN from the testnet faucet...",
        `  claimed: ${hash(1)}`,
        "Staking 1,000,000 tBRAIN at 0.2 tUSDG per task...",
        `  approved: ${hash(2)}`,
        `  staked: ${hash(3)}`,
        "Applying with a 250,000 tBRAIN bond, returned if BrainChain allows the worker...",
      ]);
      expect(lines[6]).toBe(`  applied: ${hash(4)}`);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses a name or description with characters that hide or turn text around, before reading the chain", async () => {
    const chain = fakeChain(10n ** 15n, 0n);
    const named = (name: string, about = "Summaries") =>
      join(chain as unknown as Chain, TESTNET, new Map([["name", name], ["about", about]]));
    const hidden = {
      "Claude official \u202ecilbup\u202c": "U+202E",
      "\u200bJev\u200b": "U+200B",
      "Atlas\u2066": "U+2066",
      "Atlas\nJev": "U+000A",
      "A\u00adtlas": "U+00AD",
      "Jev\u200d": "U+200D",
      "Jev\u200c": "U+200C",
      "Atlas\u2028Jev": "U+2028",
      "Atlas\u2029Jev": "U+2029",
      "\u3164": "U+3164",
      "\u2800": "U+2800",
      "Jev\u{e0041}": "U+E0041",
      "Je\u034fv": "U+034F",
      "Jev\ufe0f": "U+FE0F",
      "\u115f\u1160": "U+115F",
      "Jev\uffa0": "U+FFA0",
      "Jev\u180b": "U+180B",
      "Jev\ufff9": "U+FFF9",
      "Jev\x1b[0m": "U+001B",
    };
    for (const [name, code] of Object.entries(hidden)) {
      await expect(named(name)).rejects.toThrow(new UsageError(`--name must be one line with no invisible or direction-changing characters, and it holds ${code}`));
    }
    await expect(named("Atlas", "Summaries \u2067and more")).rejects.toThrow(
      new UsageError("--about must have no invisible or direction-changing characters, and it holds U+2067"),
    );
    await expect(named("Atlas", "Official grader\u200d. Summaries")).rejects.toThrow(
      new UsageError("--about must have no invisible or direction-changing characters, and it holds U+200D"),
    );
    await expect(named("Atlas", "Summaries\r and more")).rejects.toThrow(
      new UsageError("--about must have no invisible or direction-changing characters, and it holds U+000D"),
    );
    expect(chain.allowed).not.toHaveBeenCalled();
    for (const send of [chain.claimStakeToken, chain.approve, chain.stakeTokens, chain.setPrice, chain.apply]) expect(send).not.toHaveBeenCalled();
  });

  it("takes a description over several lines, and names in any script", async () => {
    const chain = fakeChain(88_000_000_000_000n, 0n);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await join(chain as unknown as Chain, TESTNET, new Map([["name", "Atlas 東京 Ünïcode 🤖"], ["about", "Summaries\nand code review,\twith tests"]]));
    } finally {
      log.mockRestore();
    }
    expect(chain.apply).toHaveBeenCalledOnce();
  });

  it("needs no gas when there is nothing to send", async () => {
    const chain = fakeChain(0n, 0n);
    chain.allowed.mockResolvedValue(true);
    chain.stake.mockResolvedValue({ registered: true, staked: 1_000_000n * BRAIN, unstaking: 0n, unlocksAt: 0n, price: 200_000n });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await join(chain as unknown as Chain, MAINNET, new Map([["name", "Atlas"], ["about", "Summaries"]]));
      expect(log.mock.calls.at(-1)![0]).toContain("can already be hired");
    } finally {
      log.mockRestore();
    }
  });
});

describe("join for a worker past its application", () => {
  const allowed = () => {
    const chain = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
    chain.allowed.mockResolvedValue(true);
    chain.stake.mockResolvedValue({ registered: true, staked: 0n, unstaking: 0n, unlocksAt: 0n, price: 200_000n });
    return chain;
  };
  const quietly = async (run: () => Promise<void>) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await run();
      return log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }
  };

  it("needs no name or description to stake back up, as status's hint says", async () => {
    const chain = allowed();
    await quietly(() => join(chain as unknown as Chain, MAINNET, new Map()));
    expect(chain.stakeTokens).toHaveBeenCalledOnce();
    expect(chain.apply).not.toHaveBeenCalled();
  });

  it("says when it does not use a name or description it was given", async () => {
    const lines = await quietly(() => join(allowed() as unknown as Chain, MAINNET, new Map([["name", "Atlas"], ["about", "Summaries"]])));
    expect(lines[0]).toBe("This worker is past its application, so --name and --about are not used.");
  });

  it("still asks an applicant for both, before anything is sent", async () => {
    const chain = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
    await expect(join(chain as unknown as Chain, MAINNET, new Map())).rejects.toThrow("--name is required, up to 60 characters");
    await expect(join(chain as unknown as Chain, MAINNET, new Map([["name", "Atlas"]]))).rejects.toThrow("--about is required");
    expect(chain.approve).not.toHaveBeenCalled();
  });

  it("refuses an application on a function the guardian's veto has shut, or that another proposal holds, before anything is sent", async () => {
    const values = new Map([["name", "Atlas"], ["about", "Summaries"]]);
    const vetoed = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
    vetoed.applicationVetoed.mockResolvedValue(true);
    await expect(join(vetoed as unknown as Chain, MAINNET, values)).rejects.toThrow("The guardian vetoed setWorkerAllowed on the task board, so the executor does not queue an application until the admin reopens that function. Nothing was sent.");
    const taken = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
    taken.openApplication.mockResolvedValue(9n);
    await expect(join(taken as unknown as Chain, MAINNET, values)).rejects.toThrow("Proposal 9 already asks to allow this worker and is still open");
    for (const chain of [vetoed, taken]) for (const send of [chain.claimStakeToken, chain.approve, chain.stakeTokens, chain.apply]) expect(send).not.toHaveBeenCalled();
  });

  it("does not check a veto for a worker that is not applying", async () => {
    const chain = allowed();
    chain.applicationVetoed.mockResolvedValue(true);
    await quietly(() => join(chain as unknown as Chain, MAINNET, new Map()));
    expect(chain.stakeTokens).toHaveBeenCalledOnce();
  });

  it("says an application that is waiting is waiting, rather than past", async () => {
    const waiting = () => {
      const chain = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
      chain.stake.mockResolvedValue({ registered: true, staked: 1_000_000n * BRAIN, unstaking: 0n, unlocksAt: 0n, price: 200_000n });
      chain.applications.mockResolvedValue({ applications: [{ id: 70n, state: 1, createdAt: 0n, decisionId: undefined }], change: undefined } as never);
      return chain;
    };
    const told = `Application 70 is already waiting for BrainChain's decision`;
    expect(await quietly(() => join(waiting() as unknown as Chain, MAINNET, new Map([["name", "Atlas"], ["about", "Summaries"]])))).toEqual([
      `${told}, so --name and --about are not used. ${cli("status")} says how long it has waited.`,
    ]);
    expect(await quietly(() => join(waiting() as unknown as Chain, MAINNET, new Map()))).toEqual([`${told}. ${cli("status")} says how long it has waited.`]);
  });

  it("says how it counts a name's length", async () => {
    const chain = fakeChain(10n ** 15n, 2_000_000n * BRAIN);
    await expect(join(chain as unknown as Chain, MAINNET, new Map([["name", "\u{1F600}".repeat(31)], ["about", "Summaries"]]))).rejects.toThrow("--name is at most 60 characters, counted as UTF-16 units: one for nearly all text, two or more for an emoji");
    await expect(join(chain as unknown as Chain, MAINNET, new Map([["name", "Atlas"], ["about", "x".repeat(501)]]))).rejects.toThrow("--about is at most 500 characters, counted as UTF-16 units");
  });
});

describe("fund's flags", () => {
  it("refuses --gas-usdc above --usdc without --stake, rather than ignore part of it", async () => {
    await expect(main(["fund", "--from-solana", "--usdc", "1", "--gas-usdc", "3"])).rejects.toThrow(new UsageError("--gas-usdc 3 is more than --usdc 1, the most this command may spend"));
  });
});

describe("buy-stake's flags", () => {
  it("sells eth or usdg and nothing else, and runs on mainnet only, before it reads a key", async () => {
    vi.stubEnv("BRAINCHAIN_NETWORK", "mainnet");
    try {
      await expect(main(["buy-stake", "--with", "wbtc"])).rejects.toThrow(new UsageError('--with is eth or usdg, what buy-stake sells for the BRAIN, not "wbtc"'));
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(main(["buy-stake", "--dry"])).rejects.toThrow(new UsageError("buy-stake works on mainnet only, where BRAIN trades on Robinhood Chain; on BrainChain testnet, join claims the tBRAIN from the faucet"));
    expect(() => parse("buy-stake", ["--with"])).toThrow("--with needs a value");
    // Any case of eth or usdg gets past the check to the network's, which testnet fails.
    for (const pay of ["ETH", "Usdg"]) await expect(main(["buy-stake", "--with", pay, "--dry"])).rejects.toThrow(/^buy-stake works on mainnet only/);
    expect(() => parse("buy-stake", ["--dry=1"])).toThrow("--dry takes no value");
  });

  it("says in its help what a run costs, what is checked, and what comes next", () => {
    const help = usage("buy-stake").replace(/\s+/g, " ");
    expect(help).toContain("0x's price and quote cost 0.01 USDC each, paid from the worker's key on Base, and --dry pays for both as well");
    expect(help).toContain("The wallet also pays gas on Robinhood Chain and keeps 0.0003 ETH there for the bridge's deposit.");
    expect(help).toContain("Every quote is checked and simulated before anything is signed; a sale over 7% above the BRAIN's worth at Relay's price is refused.");
    expect(help).toContain("Once the BRAIN arrives on BrainChain, run join.");
  });
});

describe("proposal", () => {
  it("needs no key, so a mistyped one in the environment does not stop it", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: method === "eth_chainId" ? `0x${TESTNET.chainId.toString(16)}` : `0x${"00".repeat(32 * 7)}` }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("BRAINCHAIN_WORKER_KEY", "not-a-key");
    vi.stubEnv("BRAINCHAIN_WORKER_KEY_FILE", "");
    vi.stubEnv("BRAINCHAIN_NETWORK", "testnet");
    vi.stubEnv("BRAINCHAIN_RPC_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      await expect(main(["proposal", "1"])).rejects.toThrow("There is no proposal 1 on BrainChain testnet");
    } finally {
      vi.unstubAllEnvs();
      server.close();
      server.closeAllConnections();
    }
  });
});

describe("watchPlace", () => {
  const LOG: Address = "0x4E4cB48f3802bD519E0Eed896dF82197B0ecBc09";

  it("keeps a place for each key apart from the place of runs without one", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "brainchain-watch-"));
    writeWatched(watchPlace(LOG, undefined), { seen: 100n }, folder);
    expect(readWatched(watchPlace(LOG, ACCOUNT), folder)).toBeUndefined();
    writeWatched(watchPlace(LOG, ACCOUNT), { seen: 94n, block: 5_000n }, folder);
    expect(readWatched(watchPlace(LOG, undefined), folder)).toEqual({ seen: 100n });
    expect(readWatched(watchPlace(LOG, ACCOUNT), folder)).toEqual({ seen: 94n, block: 5_000n });
    expect(readWatched(watchPlace(LOG, "0x00000000000000000000000000000000000000c2"), folder)).toBeUndefined();
  });
});

describe("fetchRecord", () => {
  it("stops reading a record past a megabyte", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    await expect(fetchRecord("https://brain.example/records/1.json", async () => new Response(endless))).rejects.toThrow("the record at https://brain.example/records/1.json is larger than 1000000 bytes");
    expect(pulled).toBeLessThan(20);
  });

  it("follows no redirect", async () => {
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url!);
      if (req.url === "/records/1.json") res.writeHead(302, { location: "/elsewhere/1.json" });
      res.end("a record");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await expect(fetchRecord(`http://127.0.0.1:${(server.address() as AddressInfo).port}/records/1.json`)).rejects.toThrow("fetch failed");
      expect(asked).toEqual(["/records/1.json"]);
    } finally {
      server.close();
    }
  });
});

describe("watchResume", () => {
  it("picks a long watch up where the last run stopped, and checks the latest few only on a first --once", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "brainchain-watch-"));
    const place = watchPlace("0x4E4cB48f3802bD519E0Eed896dF82197B0ecBc09", ACCOUNT);
    const first = watchResume(place, false, folder);
    expect(first.seenDecision).toBeUndefined();
    expect(first).not.toHaveProperty("recent");
    expect(watchResume(place, true, folder)).toMatchObject({ seenDecision: undefined, recent: 10n, once: true });
    first.saw(40n, undefined);
    const restarted = watchResume(place, false, folder);
    expect(restarted.seenDecision).toBe(40n);
    expect(restarted).not.toHaveProperty("recent");
    expect(restarted).not.toHaveProperty("seenBlock");
    expect(watchResume(place, true, folder).seenDecision).toBe(40n);
  });

  it("keeps the block of the latest change listed, so a later run lists only closed changes queued after it", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "brainchain-watch-"));
    const place = watchPlace("0x4E4cB48f3802bD519E0Eed896dF82197B0ecBc09", undefined);
    watchResume(place, true, folder).saw(357n, 9_120n);
    expect(watchResume(place, true, folder)).toMatchObject({ seenDecision: 357n, seenBlock: 9_120n });
    // A place from before blocks were kept still reads, and gains one at the next save.
    writeWatched(place, { seen: 357n }, folder);
    const old = watchResume(place, true, folder);
    expect(old).not.toHaveProperty("seenBlock");
    old.saw(357n, 9_120n);
    expect(readWatched(place, folder)).toEqual({ seen: 357n, block: 9_120n });
  });
});

describe("hireWatch", () => {
  it("reads again every few minutes until the worker can be hired, and gives each new answer once", async () => {
    let now = 0;
    const answers = ["no: application 9 is waiting for BrainChain's decision", undefined, "no: BrainChain allowed this worker; it can be hired after 2026-11-04T23:02:19Z", "yes"];
    const check = vi.fn(async () => answers.shift());
    const changed = hireWatch("no: application 9 is waiting for BrainChain's decision", check, 300_000, () => now);
    expect(await changed()).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    now += 300_000;
    // The same answer, then one that could not be read: nothing to say.
    expect(await changed()).toBeUndefined();
    now += 300_000;
    expect(await changed()).toBeUndefined();
    now += 300_000;
    expect(await changed()).toBe("no: BrainChain allowed this worker; it can be hired after 2026-11-04T23:02:19Z");
    now += 300_000;
    expect(await changed()).toBe("yes");
    now += 3_600_000;
    expect(await changed()).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(4);
  });
});

describe("timedLog", () => {
  it("stamps each line and says how long the log has been quiet", () => {
    let now = Date.UTC(2026, 10, 4, 12, 37, 48);
    const lines: string[] = [];
    const { log, quietFor } = timedLog((line) => lines.push(line), () => now);
    now += 3_600_000;
    expect(quietFor()).toBe(3_600_000);
    log("waiting for tasks");
    expect(lines).toEqual(["2026-11-04T13:37:48Z waiting for tasks"]);
    expect(quietFor()).toBe(0);
  });
});

describe("names every object inherits", () => {
  const inherited = ["constructor", "toString", "__proto__", "hasOwnProperty"];

  it("are not commands", async () => {
    for (const name of inherited) {
      expect(() => parse(name, [])).toThrow(UsageError);
      await expect(main([name])).rejects.toThrow(`Unknown command "${name}"`);
      expect(usage(name)).toContain("Usage:\n  brainchain-worker new-key");
    }
  });

  it("are not flags", () => {
    for (const name of inherited) {
      expect(() => parse("status", [`--${name}`])).toThrow(`The status command has no --${name} flag`);
      expect(() => parse("watch", [`--${name}`, "--once"])).toThrow(`The watch command has no --${name} flag`);
    }
  });
});

describe("commandName", () => {
  it("is the npx form when npx started the CLI, and the binary's name otherwise", () => {
    expect(commandName({ npm_command: "exec" })).toBe("npx brainchain-worker");
    expect(commandName({ npm_command: "test" })).toBe("brainchain-worker");
    expect(commandName({})).toBe("brainchain-worker");
  });
});

describe("new-key --file", () => {
  it("prints the file's full path, with ~ expanded, so it can be set from any folder", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "brainchain-worker-home-"));
    vi.stubEnv("HOME", home);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await main(["new-key", "--file", "~/k.key"]);
      expect(String(log.mock.calls[0]![0]).split("\n")[0]).toBe(`BRAINCHAIN_WORKER_KEY_FILE=${path.join(home, "k.key")}`);
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("exam, licence and papers", () => {
  const SITTING = `0x${"5a".repeat(32)}`;
  const service = "https://brain.testnet.usebrainchain.com";
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  /** Runs the CLI against a service that answers from `routes`, and returns what it printed and what it was asked. */
  async function against(routes: Record<string, () => Response>, argv: string[], env: Record<string, string> = {}) {
    const asked: { method: string; path: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const path = req.url.replace(service, "").split("?")[0]!;
      asked.push({ method: req.method, path, body: await req.text() });
      return routes[`${req.method} ${path}`]?.() ?? json({ error: "Not found." }, 404);
    });
    for (const name of ["BRAINCHAIN_WORKER_KEY", "BRAINCHAIN_WORKER_KEY_FILE", "BRAINCHAIN_NETWORK", "BRAINCHAIN_RPC_URL", "BRAINCHAIN_SERVICE_URL"]) vi.stubEnv(name, env[name] ?? "");
    // A home of its own, so nothing here reads or writes the folder a real worker keeps its sittings in.
    for (const name of ["HOME", "USERPROFILE"]) vi.stubEnv(name, mkdtempSync(path.join(tmpdir(), "brainchain-home-")));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await main(argv);
      return { lines: log.mock.calls.map((call) => String(call[0])), asked };
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }

  it("read a sitting, an agent's licences and its Papers without a key, so a mistyped one does not stop them", async () => {
    const env = { BRAINCHAIN_WORKER_KEY: "not-a-key" };
    const sitting = { sitting: SITTING, agent: { id: "7" }, class: "code", state: "open", deadline: 4_102_452_000, items: [{ index: 0, title: "Parse a duration", state: "open" }] };
    const status = await against({ [`GET /exams/${SITTING}`]: () => json(sitting) }, ["exam", "status", "--sitting", SITTING.toUpperCase().replace("0X", "0x")], env);
    expect(status.lines[0]).toBe(`Sitting ${SITTING} for agent 7, class code: open until 2100-01-01T02:00:00Z`);
    const held = await against({ "GET /licences/46630/7": () => json({ licences: [] }) }, ["license", "--agent-id", "7"], env);
    expect(held.lines).toEqual([`Agent 7 on Robinhood Chain testnet holds no licence. \`${CLI} exam info\` says what a sitting takes.`]);
    const file = await against({ "GET /papers/46630/7": () => json({ brainchain: { papers: { epoch: { number: 1, controller: ACCOUNT, build: "" }, licences: [] } } }) }, ["papers", "--agent-id", "7"], env);
    expect(file.lines[0]).toBe(`Papers of agent 7 on Robinhood Chain testnet: ${service}/papers/46630/7`);
    const info = await against({ "GET /exams": () => json({ price: "5.00 USD a sitting", classes: [{ class: "code", about: "Small Python functions." }], sitting: {} }) }, ["exam", "info"], env);
    expect(info.lines.slice(0, 3)).toEqual(["The licence exam on BrainChain testnet", "  Price     5.00 USD a sitting", "  Class     code: Small Python functions."]);
  });

  it("shows a sitting's price with the worker's key and pays nothing without --max-price", async () => {
    const offer = Buffer.from(
      JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:46630", amount: "5000000", asset: TESTNET.deskUsdg.address, payTo: TESTNET.exitDesk, maxTimeoutSeconds: 300 }] }),
    ).toString("base64");
    const routes = { "GET /exams": () => json({ price: "5.00 USD a sitting", classes: [{ class: "code", about: "" }], sitting: {} }), "POST /x402/exams": () => json({}, 402, { "payment-required": offer }) };
    const { lines, asked } = await against(routes, ["exam", "sit", "--agent-id", "7"], { BRAINCHAIN_WORKER_KEY: `0x${"4f".repeat(32)}` });
    expect(lines[0]).toMatch(/^A sitting for agent 7 in class code costs 5 test USDG on Robinhood Chain testnet, paid by 0x[0-9a-fA-F]{40} over x402\.$/);
    expect(lines.at(-1)).toBe("The service would open this sitting. Nothing was approved or paid: to sit, run this again with --max-price 5.");
    // The price is the service's answer to the request itself, sent with the wallet's signature and no payment.
    expect(asked.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /exams", "POST /x402/exams"]);
    expect(JSON.parse(asked[1]!.body)).toMatchObject({ agent: { chainId: 46630, id: "7" }, class: "code", signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) });
  });

  it("stops at the service's refusal of the request, in the service's words", async () => {
    const error = "Agent 7 holds a code licence until 2100-03-02 00:00 UTC. It may sit again from 2100-02-16 00:00 UTC. Nothing was charged.";
    const routes = { "GET /exams": () => json({ price: "5.00 USD a sitting", classes: [{ class: "code", about: "" }], sitting: {} }), "POST /x402/exams": () => json({ error }, 409) };
    const env = { BRAINCHAIN_WORKER_KEY: `0x${"4f".repeat(32)}` };
    expect(await against(routes, ["exam", "sit", "--agent-id", "7", "--max-price", "5"], env).catch((e: Error) => e.message)).toBe(error);
  });

  it("shows a sitting that is paid for and not open yet as opening", async () => {
    const opening = { sitting: SITTING, state: "opening", payment: "paid", reason: "the pool has no item left to draw", message: "The sitting is paid for and its items are being drawn." };
    const { lines } = await against({ [`GET /exams/${SITTING}`]: () => json(opening) }, ["exam", "status", "--sitting", SITTING]);
    expect(lines.slice(0, 2)).toEqual([`Sitting ${SITTING}: paid for, opening`, "  Not open yet: the pool has no item left to draw"]);
  });

  it("delivers an item's work from --file as it is, and refuses a file that is not text", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "brainchain-work-"));
    const work = path.join(folder, "item0.md");
    writeFileSync(work, "```python\ndef f(x):\n    return x\n```\n");
    const env = { BRAINCHAIN_WORKER_KEY: `0x${"4f".repeat(32)}` };
    const { lines, asked } = await against({ [`POST /exams/${SITTING}/items/0`]: () => json({ state: "submitted" }, 202) }, ["exam", "submit", "--sitting", SITTING, "--item", "0", "--file", work], env);
    expect(lines).toEqual([`Item 0 delivered (37 bytes). The desk judges it next: \`${CLI} exam status --sitting ${SITTING}\` shows the outcome.`]);
    expect((JSON.parse(asked[0]!.body) as { text: string }).text).toBe("```python\ndef f(x):\n    return x\n```\n");
    writeFileSync(work, Buffer.from([0xff, 0xfe, 0x00]));
    await expect(against({}, ["exam", "submit", "--sitting", SITTING, "--item", "0", "--file", work], env)).rejects.toThrow("The work is not valid UTF-8. Nothing was sent.");
    await expect(against({}, ["exam", "submit", "--sitting", SITTING, "--item", "0", "--file", path.join(folder, "none.md")], env)).rejects.toThrow(/none\.md, which could not be read \(ENOENT\)$/);
  });
});

describe("run --try", () => {
  it("needs no key, no stake and no chain, and says which check it could not run without a key", async () => {
    vi.stubEnv("BRAINCHAIN_WORKER_KEY", "");
    vi.stubEnv("BRAINCHAIN_WORKER_KEY_FILE", "");
    // An RPC that does not answer: --try never reads it.
    vi.stubEnv("BRAINCHAIN_RPC_URL", "http://127.0.0.1:9");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await main(["run", "--exec", "wc -l | tr -d ' '", "--try"]);
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines[1]).toMatch(/^Would deliver these \d+ bytes, which pass every check a result must:\n\d+$/);
      expect(lines.at(-1)).toBe("No key is set, so the check that a result never holds the worker's key did not run.");
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("takes neither --once nor --mint, since it delivers nothing", async () => {
    for (const flag of ["--once", "--mint"]) {
      await expect(main(["run", "--exec", "cat", "--try", flag])).rejects.toThrow(new UsageError("--try runs the command once on a sample task and delivers nothing, so it takes neither --once nor --mint"));
    }
  });
});
