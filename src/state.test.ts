import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fileStore, lock } from "./state.js";

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

  it("refuses a file that is not JSON", () => {
    const file = join(dir(), "worker.json");
    writeFileSync(file, "{");
    expect(() => fileStore(file, BOARD)).toThrow("not valid JSON");
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
