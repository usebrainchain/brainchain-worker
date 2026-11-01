import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MAINNET, TESTNET } from "./network.js";
import { fileStore, lock, openStore } from "./state.js";

const BOARD = "0xC74564F100e70F95346A6e399ebf1Ce14309C8B6";
const dir = () => mkdtempSync(join(tmpdir(), "brainchain-worker-"));

describe("fileStore", () => {
  it("keeps state in a file only its owner can read", () => {
    const file = join(dir(), "worker.json");
    const store = fileStore(file, BOARD);
    store.state.tasks["7"] = { result: "done", failures: 1, nextAt: 1_060 };
    store.state.hired = { block: 1_234, tasks: ["7"] };
    store.save();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(fileStore(file, BOARD).state).toMatchObject({ tasks: { "7": { result: "done", nextAt: 1_060 } }, hired: { block: 1_234 } });
  });

  it("drops state kept for another task board", () => {
    const file = join(dir(), "worker.json");
    const store = fileStore(file, BOARD);
    store.state.done.push("7");
    store.save();
    expect(fileStore(file, "0x0000000000000000000000000000000000000001").state.done).toEqual([]);
  });

  it("moves a file that is not a saved state aside and starts with no saved work", () => {
    const board = BOARD.toLowerCase();
    const state = (fields: object) => JSON.stringify({ board, tasks: {}, done: [], ...fields });
    const wrong = [
      "{",
      "",
      "null",
      "[]",
      "42",
      '"text"',
      JSON.stringify({ tasks: {}, done: [] }),
      JSON.stringify({ board, done: {} }),
      state({ board: 7 }),
      state({ done: {} }),
      state({ done: ["7", 8] }),
      state({ tasks: "x" }),
      state({ tasks: { "7": { failures: "1", nextAt: 0 } } }),
      state({ tasks: { "7": { failures: 0, nextAt: 1.5 } } }),
      state({ tasks: { "7": { failures: 0, nextAt: 0, stored: { uri: "https://brain.example/7", hash: "0x12" } } } }),
      state({ hired: 5 }),
      state({ hired: { block: 10, tasks: ["abc"] } }),
      state({ command: { pgid: "abc", startedAt: 0 } }),
      state({ command: { pgid: 1, startedAt: 0 } }),
      state({ proofs: [] }),
      state({ proofs: { abc: { deliveredAt: 1, nextAt: 2 } } }),
      state({ proofs: { "7": { deliveredAt: 1, nextAt: "2" } } }),
      state({ proofs: { "7": { deliveredAt: 1, nextAt: 2, paidAt: -1 } } }),
    ];
    for (const text of wrong) {
      const folder = dir();
      const file = join(folder, "worker.json");
      writeFileSync(file, text);
      const warn = vi.fn();
      const store = fileStore(file, BOARD, warn);
      expect(store.state).toEqual({ board: BOARD.toLowerCase(), tasks: {}, done: [] });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/could not be read as saved worker state, so it was moved to .*worker\.json\.corrupt-\d{8}T\d{6}Z and this run starts with no saved work$/);
      const [aside] = readdirSync(folder).filter((name) => name.startsWith("worker.json.corrupt-"));
      expect(readFileSync(join(folder, aside!), "utf8")).toBe(text);
      expect(existsSync(file)).toBe(false);
      store.save();
      expect(fileStore(file, BOARD, warn).state.done).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    }
  });

  it("keeps a saved state with every field it can hold", () => {
    const file = join(dir(), "worker.json");
    const hash = `0x${"ab".repeat(32)}`;
    const saved = {
      board: BOARD.toLowerCase(),
      tasks: { "7": { result: "done", stored: { uri: "https://brain.example/7", hash }, tx: hash, failures: 2, nextAt: 1_060 } },
      done: ["5"],
      hired: { block: 1_234, tasks: ["7"] },
      command: { pgid: 4_242, startedAt: 1_700_000_000_000 },
      proofs: { "7": { deliveredAt: 1_700_000_000, paidAt: 1_700_003_600, nextAt: 1_700_007_200 }, "8": { deliveredAt: 1_700_000_100, nextAt: 1_700_000_400 } },
    };
    writeFileSync(file, JSON.stringify(saved));
    const warn = vi.fn();
    expect(fileStore(file, BOARD, warn).state).toEqual(saved);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("lock", () => {
  it("refuses while a live process holds it", () => {
    const file = join(dir(), "worker.lock");
    writeFileSync(file, String(process.ppid));
    expect(() => lock(file)).toThrow(`pid ${process.ppid}`);
  });

  it("takes over a lock its holder left behind, and releases it", () => {
    const file = join(dir(), "worker.lock");
    writeFileSync(file, String(spawnSync("true").pid));
    const release = lock(file);
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(file)).toBe(false);
  });
});

describe("openStore", () => {
  const ADDRESS = "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4";
  const saved = (board: string, done: string[]) => JSON.stringify({ board: board.toLowerCase(), tasks: {}, done, hired: { block: 1_234, tasks: done } });
  const held = (file: string, pid: number) => `Another run (pid ${pid}) is already working for this worker. Stop it before starting another; ${file} holds its lock.`;

  it("moves state kept per address to the network whose board it holds, says so once, and drops its stale lock", () => {
    const folder = dir();
    const old = join(folder, ADDRESS);
    writeFileSync(`${old}.json`, saved(TESTNET.contracts.taskBoard, ["5"]));
    writeFileSync(`${old}.lock`, String(spawnSync("true").pid));
    const log = vi.fn();
    expect(openStore(ADDRESS, TESTNET, log, folder).state).toMatchObject({ done: ["5"], hired: { block: 1_234 } });
    expect(log.mock.calls).toEqual([[`moved ${old}.json to ${old}.testnet.json`]]);
    expect(readdirSync(folder).sort()).toEqual([`${ADDRESS}.testnet.json`, `${ADDRESS}.testnet.lock`]);
    expect(readFileSync(`${old}.testnet.lock`, "utf8")).toBe(String(process.pid));
    openStore(ADDRESS, TESTNET, log, folder);
    expect(log).toHaveBeenCalledOnce();
  });

  it("leaves state kept for the other board until a run on that network moves it", () => {
    const folder = dir();
    const old = join(folder, ADDRESS);
    const text = saved(MAINNET.contracts.taskBoard, ["5"]);
    writeFileSync(`${old}.json`, text);
    const log = vi.fn();
    expect(openStore(ADDRESS, TESTNET, log, folder).state.done).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(readFileSync(`${old}.json`, "utf8")).toBe(text);
    expect(existsSync(`${old}.testnet.json`)).toBe(false);
    expect(openStore(ADDRESS, MAINNET, log, folder).state.done).toEqual(["5"]);
    expect(log.mock.calls).toEqual([[`moved ${old}.json to ${old}.mainnet.json`]]);
    expect(existsSync(`${old}.json`)).toBe(false);
  });

  it("leaves old state alone once the network has its own", () => {
    const folder = dir();
    const old = join(folder, ADDRESS);
    writeFileSync(`${old}.json`, saved(TESTNET.contracts.taskBoard, ["5"]));
    writeFileSync(`${old}.testnet.json`, saved(TESTNET.contracts.taskBoard, ["9"]));
    const log = vi.fn();
    expect(openStore(ADDRESS, TESTNET, log, folder).state.done).toEqual(["9"]);
    expect(log).not.toHaveBeenCalled();
    expect(existsSync(`${old}.json`)).toBe(true);
  });

  it("refuses while a run from before the move works on this network, and not on the other", () => {
    const folder = dir();
    const old = join(folder, ADDRESS);
    writeFileSync(`${old}.json`, saved(MAINNET.contracts.taskBoard, ["5"]));
    writeFileSync(`${old}.lock`, String(process.ppid));
    expect(() => openStore(ADDRESS, MAINNET, undefined, folder)).toThrow(held(`${old}.lock`, process.ppid));
    expect(existsSync(`${old}.json`)).toBe(true);
    expect(openStore(ADDRESS, TESTNET, undefined, folder).state.done).toEqual([]);
  });

  it("runs one key on testnet and mainnet at once, each with its own lock and state", () => {
    const folder = dir();
    const testnet = openStore(ADDRESS, TESTNET, undefined, folder);
    testnet.state.hired = { block: 1_234, tasks: ["7"] };
    testnet.save();
    // Held by a live process from here on, as a testnet run in another terminal would hold it.
    writeFileSync(join(folder, `${ADDRESS}.testnet.lock`), String(process.ppid));

    const mainnet = openStore(ADDRESS, MAINNET, undefined, folder);
    expect(mainnet.state).toEqual({ board: MAINNET.contracts.taskBoard.toLowerCase(), tasks: {}, done: [] });
    mainnet.state.hired = { block: 99, tasks: [] };
    mainnet.save();
    expect(readFileSync(join(folder, `${ADDRESS}.mainnet.lock`), "utf8")).toBe(String(process.pid));
    expect(readFileSync(join(folder, `${ADDRESS}.testnet.lock`), "utf8")).toBe(String(process.ppid));
    expect(fileStore(join(folder, `${ADDRESS}.testnet.json`), TESTNET.contracts.taskBoard).state.hired).toEqual({ block: 1_234, tasks: ["7"] });
  });

  it("names the network's lock file when another run holds it", () => {
    const folder = dir();
    const file = join(folder, `${ADDRESS}.testnet.lock`);
    writeFileSync(file, String(process.ppid));
    expect(() => openStore(ADDRESS, TESTNET, undefined, folder)).toThrow(held(file, process.ppid));
  });
});
