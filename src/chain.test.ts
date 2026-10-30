import { describe, expect, it, vi } from "vitest";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, HttpRequestError, keccak256, toBytes } from "viem";

import { taskBoardAbi, workerStakingAbi } from "./abi.js";
import { erc20Abi, faucetReopens, fetchBrief, PermanentError, reason, resultMessage, submitFailure, unhealthy, workerId } from "./chain.js";
import { resolveNetwork } from "./network.js";

const brief = JSON.stringify({ title: "Haiku", brief: "Write a haiku about rollups", levels: ["Great", "Fine", "Poor"], passIndex: 1 });
const briefHash = keccak256(toBytes(brief));
const dataURI = `data:application/json;base64,${Buffer.from(brief).toString("base64")}`;

function reverted(abi: typeof taskBoardAbi | typeof workerStakingAbi | typeof erc20Abi, errorName: string, functionName: string, args?: unknown[]) {
  const data = encodeErrorResult({ abi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);
  const revert = new ContractFunctionRevertedError({ abi, data, functionName });
  return new ContractFunctionExecutionError(revert, { abi, functionName, args: [] });
}

describe("fetchBrief", () => {
  it("checks a brief against its hash", async () => {
    expect(await fetchBrief(dataURI, briefHash)).toBe(brief);
    await expect(fetchBrief(dataURI, keccak256(toBytes("other")))).rejects.toThrow(PermanentError);
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

describe("chain helpers", () => {
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
    expect(submitFailure(reverted(taskBoardAbi, "TooLate", "submit"))).toEqual(new PermanentError("The deadline passed before the result could be submitted"));
    expect(submitFailure(reverted(taskBoardAbi, "BadStatus", "submit"))).toBeInstanceOf(PermanentError);
    const other = reverted(taskBoardAbi, "NotWorker", "submit");
    expect(submitFailure(other)).toBe(other);
  });

  it("names the contract error a call reverted with", () => {
    expect(reason(reverted(workerStakingAbi, "Locked", "withdraw"))).toBe('The contract function "withdraw" reverted. (Locked)');
  });

  it("reads when the faucet opens again from its TooSoon revert", () => {
    expect(faucetReopens(reverted(erc20Abi, "TooSoon", "faucet", [1_793_462_553n]))).toBe(1_793_462_553n);
    expect(faucetReopens(reverted(workerStakingAbi, "Locked", "withdraw"))).toBeUndefined();
    expect(faucetReopens(new Error("fetch failed"))).toBeUndefined();
  });

  it("names the RPC by host only", () => {
    const error = new HttpRequestError({ url: "https://rpc.example.com/v2/secret-api-key", details: "fetch failed" });
    expect(reason(error)).toBe("Could not reach rpc.example.com (fetch failed)");
    expect(reason(new BaseError("Request failed", { cause: error }))).not.toContain("secret-api-key");
  });

  it("refuses an RPC URL that does not parse without printing it", () => {
    for (const rpc of ["rpc.example.com/v2/APIKEYSECRET123", "https//rpc.example.com/v2/APIKEYSECRET123", "rpc.example.com:8545/APIKEYSECRET123"]) {
      expect(() => resolveNetwork({ BRAINCHAIN_RPC_URL: rpc })).toThrow("BRAINCHAIN_RPC_URL is not a valid URL");
      expect(() => resolveNetwork({ BRAINCHAIN_RPC_URL: rpc })).not.toThrow("APIKEYSECRET123");
    }
    expect(resolveNetwork({ BRAINCHAIN_RPC_URL: "https://rpc.example.com/v2/key\n" }).rpc).toBe("https://rpc.example.com/v2/key");
  });

  it("cuts a web page the RPC answered with to one short line", () => {
    const page = `<!doctype html>\n<html lang="en">\n\t<head><title>Example Domain</title></head>\x07\n${"<p>filler</p>\n".repeat(80)}</html>`;
    const line = reason(new HttpRequestError({ url: "https://example.com/APIKEYSECRET123", details: JSON.stringify(page) }));
    expect(line).toMatch(/^Could not reach example\.com \(<!doctype html> <html lang="en"> <head><title>Example Domain<\/title><\/head> <p>filler/);
    expect(line.length).toBe("Could not reach example.com ()".length + 160);
    expect(line).not.toMatch(/[\x00-\x1f]/);
    expect(line).not.toContain("APIKEYSECRET123");
  });

  it("takes a BrainChain service over https only, or http on this machine", () => {
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "https://brain.example.com/" }).service).toBe("https://brain.example.com");
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://127.0.0.1:3000" }).service).toBe("http://127.0.0.1:3000");
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://localhost:3000" }).service).toBe("http://localhost:3000");
    expect(() => resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://brain.example.com" })).toThrow("https");
  });

  it("names the service's host when it fails its health check", async () => {
    const service = "https://brain.example.com/v1";
    const ok = vi.fn<typeof fetch>(async () => new Response('{"ok":true}'));
    expect(await unhealthy(service, ok)).toBeUndefined();
    expect(ok.mock.calls[0]![0]).toBe("https://brain.example.com/v1/health");
    expect(await unhealthy(service, async () => new Response("down", { status: 503 }))).toBe(
      "the BrainChain service at brain.example.com answered its health check with 503",
    );
    expect(
      await unhealthy("http://localhost:1", async () => {
        throw new TypeError("fetch failed");
      }),
    ).toBe("could not reach the BrainChain service at localhost:1");
  });
});
