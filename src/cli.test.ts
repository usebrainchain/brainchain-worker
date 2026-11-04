import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseEther, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { Chain } from "./chain.js";
import { asksHelp, hireWatch, join, main, parse, timedLog, usage, UsageError, watching, watchPlace } from "./cli.js";
import { MAINNET, TESTNET, type Network } from "./network.js";
import { gasHelp } from "./standing.js";
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

function fakeChain(gas: bigint, balance: bigint, sent = 0) {
  const send = () => vi.fn(async () => undefined);
  return {
    account: ACCOUNT,
    ethBalance: vi.fn(async () => gas),
    sent: vi.fn(async () => sent),
    gasPrice: vi.fn(async () => 100_000_000n),
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

  const gas = (holds: string, need: string, network: Network = MAINNET) =>
    `${ACCOUNT} holds ${holds} ETH on ${network.name}; join needs about ${need} ETH for gas. ${gasHelp(network, ACCOUNT, parseEther(holds), 0)}.`;
  const short = `The wallet holds 0 BRAIN of the 1,250,000 BRAIN join needs. ${MAINNET.buyStake}`;

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
        "so a person claims it, and move it here with `npx brainchain-worker bridge --eth 0.001`. The gas drip serves each address once.",
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

describe("watchPlace", () => {
  const LOG: Address = "0x4E4cB48f3802bD519E0Eed896dF82197B0ecBc09";

  it("keeps a place for each key apart from the place of runs without one", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "brainchain-watch-"));
    writeWatched(watchPlace(LOG, undefined), 100n, folder);
    expect(readWatched(watchPlace(LOG, ACCOUNT), folder)).toBeUndefined();
    writeWatched(watchPlace(LOG, ACCOUNT), 94n, folder);
    expect(readWatched(watchPlace(LOG, undefined), folder)).toBe(100n);
    expect(readWatched(watchPlace(LOG, ACCOUNT), folder)).toBe(94n);
    expect(readWatched(watchPlace(LOG, "0x00000000000000000000000000000000000000c2"), folder)).toBeUndefined();
  });
});

describe("hireWatch", () => {
  it("reads again every few minutes until the worker can be hired, and gives each new answer once", async () => {
    let now = 0;
    const answers = ["no: application 9 is waiting for Jev", undefined, "no: Jev allowed this worker; it can be hired after 2026-11-04T23:02:19Z", "yes"];
    const check = vi.fn(async () => answers.shift());
    const changed = hireWatch("no: application 9 is waiting for Jev", check, 300_000, () => now);
    expect(await changed()).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    now += 300_000;
    // The same answer, then one that could not be read: nothing to say.
    expect(await changed()).toBeUndefined();
    now += 300_000;
    expect(await changed()).toBeUndefined();
    now += 300_000;
    expect(await changed()).toBe("no: Jev allowed this worker; it can be hired after 2026-11-04T23:02:19Z");
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
