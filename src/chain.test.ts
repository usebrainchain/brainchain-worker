import { describe as group, expect, it, vi } from "vitest";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, HttpRequestError, keccak256, toBytes } from "viem";

import { taskBoardAbi, workerStakingAbi } from "./abi.js";
import { describe, fetchBrief, Permanent, resultMessage, submitFailure, workerId } from "./chain.js";
import { resolveNetwork } from "./network.js";

const brief = JSON.stringify({ title: "Haiku", brief: "Write a haiku about rollups", levels: ["Great", "Fine", "Poor"], passIndex: 1 });
const briefHash = keccak256(toBytes(brief));
const dataURI = `data:application/json;base64,${Buffer.from(brief).toString("base64")}`;

function reverted(abi: typeof taskBoardAbi | typeof workerStakingAbi, errorName: string, functionName: string) {
  const data = encodeErrorResult({ abi, errorName } as Parameters<typeof encodeErrorResult>[0]);
  const revert = new ContractFunctionRevertedError({ abi, data, functionName });
  return new ContractFunctionExecutionError(revert, { abi, functionName, args: [] });
}

group("fetchBrief", () => {
  it("checks a brief against its hash", async () => {
    expect(await fetchBrief(dataURI, briefHash)).toBe(brief);
    await expect(fetchBrief(dataURI, keccak256(toBytes("other")))).rejects.toThrow(Permanent);
    await expect(fetchBrief("http://example.com/brief.json", briefHash)).rejects.toThrow("neither");
  });

  it("fetches only from public hosts", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const host of ["127.0.0.1", "2130706433", "[::1]", "localhost", "api.localhost", "printer.local", "metadata.google.internal", "intranet"]) {
      await expect(fetchBrief(`https://${host}/brief.json`, briefHash, fetcher)).rejects.toThrow("not a public host");
    }
    expect(fetcher).not.toHaveBeenCalled();
    const ok = vi.fn<typeof fetch>(async () => new Response(brief));
    expect(await fetchBrief("https://briefs.example.com/1.json", briefHash, ok)).toBe(brief);
  });

  it("stops reading a brief past 256 KB", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    await expect(fetchBrief("https://briefs.example.com/big.json", briefHash, async () => new Response(endless))).rejects.toThrow("larger than 256 KB");
    expect(pulled).toBeLessThan(10);
  });
});

group("chain helpers", () => {
  it("derives the staking id", () => {
    expect(workerId("0x00000000000000000000000000000000000000C1")).toBe(`0x${"0".repeat(62)}c1`);
  });

  it("signs a result upload with the v2 message", () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    expect(resultMessage(274630, "0xC74564F100e70F95346A6e399ebf1Ce14309C8B6", 7n, hash)).toBe(
      `BrainChain result v2\nchain 274630\nboard 0xc74564f100e70f95346a6e399ebf1ce14309c8b6\ntask 7\nhash ${hash}`,
    );
  });

  it("makes a submit that can never succeed permanent", () => {
    expect(submitFailure(reverted(taskBoardAbi, "TooLate", "submit"))).toEqual(new Permanent("The deadline passed before the result could be submitted"));
    expect(submitFailure(reverted(taskBoardAbi, "BadStatus", "submit"))).toBeInstanceOf(Permanent);
    const other = reverted(taskBoardAbi, "NotWorker", "submit");
    expect(submitFailure(other)).toBe(other);
  });

  it("names the contract error a call reverted with", () => {
    expect(describe(reverted(workerStakingAbi, "Locked", "withdraw"))).toBe('The contract function "withdraw" reverted. (Locked)');
  });

  it("names the RPC by host only", () => {
    const error = new HttpRequestError({ url: "https://rpc.example.com/v2/secret-api-key", details: "fetch failed" });
    expect(describe(error)).toBe("Could not reach rpc.example.com (fetch failed)");
    expect(describe(new BaseError("Request failed", { cause: error }))).not.toContain("secret-api-key");
  });

  it("takes a BrainChain service over https only, or http on this machine", () => {
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "https://brain.example.com/" }).service).toBe("https://brain.example.com");
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://127.0.0.1:3000" }).service).toBe("http://127.0.0.1:3000");
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://localhost:3000" }).service).toBe("http://localhost:3000");
    expect(() => resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://brain.example.com" })).toThrow("https");
  });
});
