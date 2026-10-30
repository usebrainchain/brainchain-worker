import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, type Hex } from "viem";

import { fetchBrief, workerId, type HiredTask, type WorkerChain } from "./chain.js";
import { createWork, MAX_RESULT_BYTES, resultURI, shellCommand, type Command } from "./work.js";

const brief = JSON.stringify({ title: "Haiku", brief: "Write a haiku about rollups", levels: ["Great", "Fine", "Poor"], passIndex: 1 });
const dataURI = (text: string) => `data:application/json;base64,${Buffer.from(text).toString("base64")}`;
const task: HiredTask = { id: 7n, deadline: 10_000n, briefURI: dataURI(brief), briefHash: keccak256(toBytes(brief)) };

function setup(output: () => Promise<string>, format: "prompt" | "json" = "prompt") {
  let now = 1_000n;
  let hired = [task];
  const chain = {
    now: vi.fn(async () => now),
    hired: vi.fn(async () => hired),
    submit: vi.fn(async (_id: bigint, _hash: Hex, _uri: string): Promise<Hex> => {
      hired = [];
      return "0xabc";
    }),
  } satisfies WorkerChain;
  const command: Command = { run: vi.fn(async () => output()) };
  const log = vi.fn();
  const work = createWork({ chain, command, format, log });
  return { chain, command, log, work, at: (t: bigint) => (now = t) };
}

describe("work", () => {
  it("runs the command on the task and submits its output inline", async () => {
    const { chain, command, work } = setup(async () => "Batches settle down\n");
    expect(await work.round()).toEqual({ delivered: 1, failed: 0 });
    const [input, env] = vi.mocked(command.run).mock.calls[0]!;
    expect(input).toContain("Write a haiku about rollups");
    expect(input).toContain('"passLevel": "Fine"');
    expect(input).toContain("untrusted poster");
    expect(env).toEqual({ BRAINCHAIN_TASK_ID: "7" });
    const [id, hash, uri] = chain.submit.mock.calls[0]!;
    expect(id).toBe(7n);
    expect(hash).toBe(keccak256(toBytes("Batches settle down")));
    expect(Buffer.from(uri.split(",")[1]!, "base64").toString()).toBe("Batches settle down");
    expect(uri.startsWith("data:text/plain;charset=utf-8;base64,")).toBe(true);
  });

  it("gives a program the task as JSON when asked", async () => {
    const { command, work } = setup(async () => "done", "json");
    await work.round();
    const input = JSON.parse(vi.mocked(command.run).mock.calls[0]![0]);
    expect(input).toMatchObject({ task: "7", title: "Haiku", passLevel: "Fine", levels: ["Great", "Fine", "Poor"] });
  });

  it("retries a failed run after a wait and keeps a finished result when only the submit failed", async () => {
    const { chain, command, work, at } = setup(async () => "");
    expect(await work.round()).toEqual({ delivered: 0, failed: 1 });
    await work.round();
    expect(command.run).toHaveBeenCalledOnce();

    vi.mocked(command.run).mockResolvedValue("ok");
    chain.submit.mockRejectedValueOnce(new Error("nonce too low"));
    at(1_100n);
    await work.round();
    at(1_400n);
    expect((await work.round()).delivered).toBe(1);
    expect(command.run).toHaveBeenCalledTimes(2);
  });

  it("refuses a result too large to fit on chain", async () => {
    const { chain, log, work } = setup(async () => "x".repeat(MAX_RESULT_BYTES + 1));
    await work.round();
    expect(chain.submit).not.toHaveBeenCalled();
    expect(log.mock.calls.at(-1)![0]).toContain("fit on chain");
  });

  it("leaves a task it can no longer deliver in time", async () => {
    const { command, log, work, at } = setup(async () => "late");
    at(9_950n);
    await work.round();
    expect(command.run).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toContain("poster is refunded");
  });
});

describe("shellCommand", () => {
  it("pipes the input through and returns stdout", async () => {
    expect(await shellCommand("tr a-z A-Z").run("hello", {}, 5_000)).toBe("HELLO");
    expect(await shellCommand('printf "$BRAINCHAIN_TASK_ID"').run("", { BRAINCHAIN_TASK_ID: "9" }, 5_000)).toBe("9");
  });

  it("fails on a non-zero exit and on a timeout", async () => {
    await expect(shellCommand("exit 3").run("", {}, 5_000)).rejects.toThrow("code 3");
    await expect(shellCommand("sleep 5").run("", {}, 200)).rejects.toThrow("was stopped");
  });
});

describe("chain helpers", () => {
  it("checks a brief against its hash", async () => {
    expect(await fetchBrief(task.briefURI, task.briefHash)).toBe(brief);
    await expect(fetchBrief(task.briefURI, keccak256(toBytes("other")))).rejects.toThrow("does not match");
    await expect(fetchBrief("http://example.com/brief.json", task.briefHash)).rejects.toThrow("neither");
  });

  it("derives the staking id and the inline result", () => {
    expect(workerId("0x00000000000000000000000000000000000000C1")).toBe(`0x${"0".repeat(62)}c1`);
    expect(resultURI("é").bytes).toBe(2);
  });
});
