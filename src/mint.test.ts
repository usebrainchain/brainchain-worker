import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeAbiParameters, encodeEventTopics, parseAbi, parseEther, zeroAddress, type Address, type Hex, type Log } from "viem";
import { describe, expect, it, vi } from "vitest";

import { collectionAbi, createProofMinter, mint, mintedToken, type ProofsChain } from "./mint.js";
import { MAINNET, TESTNET, type Network } from "./network.js";
import { fileStore, memoryStore, type Store } from "./state.js";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000C1";
const TX: Hex = `0x${"fe".repeat(32)}`;
const PRICE = parseEther("0.001");
const NOW = 1_800_000_000;
const BOARD = MAINNET.contracts.taskBoard;
const PENDING = `https://brain.usebrainchain.com/proofs/274663/pending/${ACCOUNT}`;

/** A Proofs chain that records what it is asked to send, in order. */
function fakeChain(options: { weth?: bigint; eth?: bigint; opensAt?: bigint } = {}) {
  const sent: string[] = [];
  let weth = options.weth ?? parseEther("0.01");
  let opensAt = options.opensAt ?? 0n;
  let tokenId = 28n;
  const chain = {
    account: ACCOUNT,
    price: vi.fn(async () => PRICE),
    weth: vi.fn(async () => weth),
    ethBalance: vi.fn(async () => options.eth ?? parseEther("0.001")),
    faucetOpensAt: vi.fn(async () => opensAt),
    claimWeth: vi.fn(async () => {
      sent.push("faucet");
      weth += parseEther("1");
      opensAt = BigInt(NOW + 86_400);
    }),
    approve: vi.fn(async (amount: bigint) => void sent.push(`approve ${amount}`)),
    mint: vi.fn(async () => {
      sent.push("mint");
      weth -= PRICE;
      tokenId += 1n;
      return { tokenId, tx: TX };
    }),
  } satisfies ProofsChain;
  return { chain, sent };
}

const listing = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => Response.json(body, { status }));

async function mintRun(chain: ProofsChain, fetcher: typeof fetch, options: { dry?: boolean; count?: number; network?: Network } = {}) {
  const lines: string[] = [];
  await mint(options.network ?? MAINNET, chain, { count: options.count, dry: options.dry ?? false, log: (line) => lines.push(line), fetcher, now: () => NOW });
  return lines;
}

describe("mint", () => {
  it("approves the price and mints one piece for each task the service lists, and prints the task, token id and hash", async () => {
    const { chain, sent } = fakeChain();
    const fetcher = listing({ tasks: ["12", "15", "12"] });
    const lines = await mintRun(chain, fetcher);
    expect(fetcher.mock.calls[0]![0]).toBe(PENDING);
    expect(sent).toEqual([`approve ${PRICE}`, "mint", `approve ${PRICE}`, "mint"]);
    expect(lines).toEqual([
      "Minting 2 Proofs on Robinhood Chain at 0.001 WETH each plus gas...",
      `Minted Proof 29 for task 12 (${TX}).`,
      `Minted Proof 30 for task 15 (${TX}).`,
    ]);
  });

  it("sends nothing on a dry run", async () => {
    const { chain, sent } = fakeChain();
    const lines = await mintRun(chain, listing({ tasks: ["12", "15", "18"] }), { dry: true });
    expect(sent).toEqual([]);
    expect(lines).toEqual(["Dry run, nothing sent: mint would mint 3 Proofs on Robinhood Chain for tasks 12, 15 and 18, at 0.001 WETH each plus gas."]);
  });

  it("says exactly how much WETH is missing, and sends nothing", async () => {
    const { chain, sent } = fakeChain({ weth: parseEther("0.0005") });
    await expect(mintRun(chain, listing({ tasks: ["12", "15"] }))).rejects.toThrow(
      `${ACCOUNT} holds 0.0005 WETH on Robinhood Chain, and 2 Proofs cost 0.002 WETH plus gas. ` +
        "Send it 0.0015 WETH (0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73) on Robinhood Chain. Then run mint again.",
    );
    expect(sent).toEqual([]);
    expect(await mintRun(chain, listing({ tasks: ["12"] }), { dry: true })).toEqual([
      "Dry run, nothing sent: mint would mint 1 Proof on Robinhood Chain for task 12, at 0.001 WETH each plus gas.",
      `${ACCOUNT} holds 0.0005 WETH on Robinhood Chain, and 1 Proof costs 0.001 WETH plus gas. Send it 0.0005 WETH (0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73) on Robinhood Chain.`,
    ]);
  });

  it("says the wallet needs ETH on Robinhood Chain for gas", async () => {
    const { chain, sent } = fakeChain({ eth: 0n });
    await expect(mintRun(chain, listing({ tasks: ["12"] }))).rejects.toThrow(
      `${ACCOUNT} holds 0.01 WETH and no ETH on Robinhood Chain, and 1 Proof costs 0.001 WETH plus gas. Send it a little ETH there for gas. Then run mint again.`,
    );
    expect(sent).toEqual([]);
  });

  it("claims test WETH from the faucet on testnet when the wallet is short and the faucet is open", async () => {
    const { chain, sent } = fakeChain({ weth: 0n });
    const fetcher = listing({ tasks: ["4"] });
    const lines = await mintRun(chain, fetcher, { network: TESTNET });
    expect(fetcher.mock.calls[0]![0]).toBe(`https://brain.testnet.usebrainchain.com/proofs/274630/pending/${ACCOUNT}`);
    expect(sent).toEqual(["faucet", `approve ${PRICE}`, "mint"]);
    expect(lines).toEqual(["Claiming test WETH from the faucet...", "Minting 1 Proof on Robinhood Chain testnet at 0.001 WETH each plus gas...", `Minted Proof 29 for task 4 (${TX}).`]);

    const dry = fakeChain({ weth: 0n });
    expect((await mintRun(dry.chain, listing({ tasks: ["4"] }), { network: TESTNET, dry: true })).at(-1)).toBe(
      "The wallet is short of WETH, so mint would claim test WETH from the faucet first.",
    );
    expect(dry.sent).toEqual([]);
  });

  it("says when the test WETH faucet opens again for the wallet", async () => {
    const { chain, sent } = fakeChain({ weth: 0n, opensAt: BigInt(NOW + 3_600) });
    await expect(mintRun(chain, listing({ tasks: ["4"] }), { network: TESTNET })).rejects.toThrow(
      `${ACCOUNT} holds 0 WETH on Robinhood Chain testnet, and 1 Proof costs 0.001 WETH plus gas. ` +
        "The test WETH faucet allows one claim a day, and this wallet can claim again at 2027-01-15T09:00:00Z. Then run mint again.",
    );
    expect(sent).toEqual([]);
  });

  it("mints at most 10 a run, or --count, and says how many tasks are left", async () => {
    const tasks = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const all = fakeChain({ weth: parseEther("1") });
    expect((await mintRun(all.chain, listing({ tasks }))).at(-1)).toBe("2 more paid tasks wait for a Proof: run mint again.");
    expect(all.chain.mint).toHaveBeenCalledTimes(10);

    const one = fakeChain();
    const lines = await mintRun(one.chain, listing({ tasks: ["12", "15"] }), { count: 1 });
    expect(one.chain.mint).toHaveBeenCalledOnce();
    expect(lines.at(-1)).toBe("1 more paid task waits for a Proof: run mint again.");
  });

  it("says so when no paid task waits for a Proof", async () => {
    const { chain } = fakeChain();
    expect(await mintRun(chain, listing({ tasks: [] }))).toEqual([
      `The BrainChain service lists no paid task of ${ACCOUNT} waiting for a Proof, so there is nothing to mint.`,
    ]);
    expect(chain.price).not.toHaveBeenCalled();
  });

  it("names a service that does not list the tasks yet, or answers in a form it cannot read", async () => {
    const { chain } = fakeChain();
    await expect(mintRun(chain, listing({ error: "Not Found" }, 404))).rejects.toThrow(
      "The BrainChain service at brain.usebrainchain.com does not list the tasks waiting for a Proof yet",
    );
    await expect(mintRun(chain, listing({}, 502))).rejects.toThrow("The BrainChain service at brain.usebrainchain.com answered 502");
    for (const body of [{}, { tasks: "1" }, { tasks: [1] }, { tasks: ["0x1"] }, null]) {
      await expect(mintRun(chain, listing(body))).rejects.toThrow("in a form the worker cannot read");
    }
    expect(chain.mint).not.toHaveBeenCalled();
  });
});

describe("mintedToken", () => {
  const COLLECTION: Address = "0x324B52EE2182641ec29652076ab541bc9F9907d2";
  const WETH: Address = "0x1F852eF3Afa13156b807204d838BbB46B4b452eb";
  const erc20Transfer = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const log = (address: Address, topics: Hex[], data: Hex = "0x"): Log => ({
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: TX,
    transactionIndex: 0,
    removed: false,
  });
  const piece = (address: Address, from: Address, to: Address, tokenId: bigint) =>
    log(address, encodeEventTopics({ abi: collectionAbi, eventName: "Transfer", args: { from, to, tokenId } }) as Hex[]);

  it("reads the token id from the collection's Transfer from the zero address to the worker", () => {
    const logs = [
      log(WETH, encodeEventTopics({ abi: erc20Transfer, eventName: "Transfer", args: { from: ACCOUNT, to: COLLECTION } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [PRICE])),
      piece("0x00000000000000000000000000000000000000d1", zeroAddress, ACCOUNT, 7n),
      piece(COLLECTION, zeroAddress, "0x00000000000000000000000000000000000000e1", 8n),
      piece(COLLECTION, zeroAddress, ACCOUNT, 29n),
    ];
    expect(mintedToken(logs, COLLECTION, ACCOUNT)).toBe(29n);
    expect(mintedToken(logs.slice(0, 3), COLLECTION, ACCOUNT)).toBeUndefined();
  });
});

describe("run's proof minter", () => {
  function setup(options: { store?: Store; enabled?: boolean; network?: Network; fetcher?: ReturnType<typeof listing>; chain?: ReturnType<typeof fakeChain> } = {}) {
    let now = NOW;
    let outcome: "paid" | "refunded" | undefined;
    const { chain, sent } = options.chain ?? fakeChain();
    const settled = vi.fn(async (_task: bigint) => outcome);
    const log = vi.fn<(message: string) => void>();
    const fetcher = options.fetcher ?? listing({ tasks: ["7"] });
    const store = options.store ?? memoryStore(BOARD);
    const minter = createProofMinter({ network: options.network ?? MAINNET, chain, settled, store, log, enabled: options.enabled ?? true, fetcher, now: () => now });
    return {
      minter,
      chain,
      sent,
      settled,
      log,
      fetcher,
      store,
      at: (seconds: number) => void (now = NOW + seconds),
      settle: (value: typeof outcome) => void (outcome = value),
    };
  }
  const logged = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map((call) => String(call[0]));
  const stateFile = () => join(mkdtempSync(join(tmpdir(), "brainchain-worker-")), "worker.json");

  it("mints once for a delivered task when it is paid, and a restart does not mint it again", async () => {
    const file = stateFile();
    const first = setup({ store: fileStore(file, BOARD) });
    first.minter.track(7n);
    await first.minter.round();
    expect(first.settled).not.toHaveBeenCalled();

    first.at(300);
    await first.minter.round();
    expect(first.settled).toHaveBeenCalledWith(7n);
    expect(first.fetcher).not.toHaveBeenCalled();

    first.settle("paid");
    first.at(600);
    await first.minter.round();
    expect(first.fetcher.mock.calls[0]![0]).toBe(PENDING);
    expect(first.sent).toEqual([`approve ${PRICE}`, "mint"]);
    expect(logged(first.log)).toEqual([`minted proof 29 for task 7 (${TX})`]);
    expect(first.store.state.proofs).toEqual({});

    const second = setup({ store: fileStore(file, BOARD) });
    second.settle("paid");
    second.at(4_000);
    await second.minter.round();
    expect(second.settled).not.toHaveBeenCalled();
    expect(second.chain.mint).not.toHaveBeenCalled();
  });

  it("tries a task at most once an hour, across a restart", async () => {
    const file = stateFile();
    const first = setup({ store: fileStore(file, BOARD) });
    first.minter.track(7n);
    first.settle("paid");
    first.at(300);
    first.chain.mint.mockRejectedValueOnce(new Error("The worker was killed here"));
    await first.minter.round();
    expect(logged(first.log)).toEqual(["task 7: minting its proof failed (The worker was killed here); trying again in an hour"]);

    const second = setup({ store: fileStore(file, BOARD) });
    second.at(300 + 1_800);
    await second.minter.round();
    expect(second.chain.mint).not.toHaveBeenCalled();
    expect(second.fetcher).not.toHaveBeenCalled();

    second.at(300 + 3_600);
    await second.minter.round();
    expect(second.chain.mint).toHaveBeenCalledOnce();
    expect(logged(second.log)).toEqual([`minted proof 29 for task 7 (${TX})`]);
  });

  it("leaves a task the service no longer lists, as when a mint that seemed to fail landed", async () => {
    const t = setup({ fetcher: listing({ tasks: [] }) });
    t.minter.track(7n);
    t.settle("paid");
    t.at(300);
    await t.minter.round();
    expect(t.store.state.proofs?.["7"]).toBeDefined();
    t.at(300 + 900);
    await t.minter.round();
    expect(t.chain.mint).not.toHaveBeenCalled();
    expect(t.store.state.proofs).toEqual({});
    expect(logged(t.log)).toEqual(["task 7: the BrainChain service lists no proof waiting for it, so the worker mints none"]);
  });

  it("says why it mints nothing: no WETH, no ETH or a service that does not list the tasks yet", async () => {
    const cases = [
      {
        chain: fakeChain({ weth: 0n }),
        fetcher: listing({ tasks: ["7"] }),
        line: `task 7: no proof minted yet. ${ACCOUNT} holds 0 WETH on Robinhood Chain, and 1 Proof costs 0.001 WETH plus gas. Send it 0.001 WETH (0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73) on Robinhood Chain. Trying again in an hour.`,
      },
      {
        chain: fakeChain({ eth: 0n }),
        fetcher: listing({ tasks: ["7"] }),
        line: `task 7: no proof minted yet. ${ACCOUNT} holds 0.01 WETH and no ETH on Robinhood Chain, and 1 Proof costs 0.001 WETH plus gas. Send it a little ETH there for gas. Trying again in an hour.`,
      },
      {
        chain: fakeChain(),
        fetcher: listing({ error: "Not Found" }, 404),
        line: "task 7: no proof minted yet (The BrainChain service at brain.usebrainchain.com does not list the tasks waiting for a Proof yet); trying again in an hour",
      },
    ];
    for (const { chain, fetcher, line } of cases) {
      const t = setup({ chain, fetcher });
      t.minter.track(7n);
      t.settle("paid");
      t.at(300);
      await t.minter.round();
      expect(logged(t.log)).toEqual([line]);
      expect(t.sent).toEqual([]);
      t.at(300 + 3_599);
      await t.minter.round();
      expect(t.log).toHaveBeenCalledOnce();
    }
  });

  it("claims test WETH from the faucet on testnet", async () => {
    const t = setup({ network: TESTNET, chain: fakeChain({ weth: 0n }), fetcher: listing({ tasks: ["7"] }) });
    t.minter.track(7n);
    t.settle("paid");
    t.at(300);
    await t.minter.round();
    expect(t.sent).toEqual(["faucet", `approve ${PRICE}`, "mint"]);
    expect(logged(t.log)).toEqual(["claiming test WETH from the faucet", `minted proof 29 for task 7 (${TX})`]);
  });

  it("stops watching a refunded task, and one that has not settled a day after delivery", async () => {
    const refunded = setup();
    refunded.minter.track(7n);
    refunded.settle("refunded");
    refunded.at(300);
    await refunded.minter.round();
    expect(logged(refunded.log)).toEqual(["task 7: refunded to its poster, so it gets no proof"]);
    expect(refunded.store.state.proofs).toEqual({});

    const stuck = setup();
    stuck.minter.track(7n);
    stuck.at(86_400);
    await stuck.minter.round();
    expect(logged(stuck.log)).toEqual(["task 7: not settled a day after delivery, so the worker mints no proof for it"]);
    expect(stuck.fetcher).not.toHaveBeenCalled();
  });

  it("watches and mints nothing under --no-mint", async () => {
    const t = setup({ enabled: false });
    t.minter.track(7n);
    t.settle("paid");
    t.at(3_600);
    await t.minter.round();
    expect(t.store.state.proofs).toBeUndefined();
    expect(t.settled).not.toHaveBeenCalled();
    expect(t.fetcher).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });
});
