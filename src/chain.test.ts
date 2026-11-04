import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  encodeEventTopics,
  encodeFunctionResult,
  InsufficientFundsError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeErrorResult,
  http,
  HttpRequestError,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { taskBoardAbi, workerStakingAbi } from "./abi.js";
import { createChain, erc20Abi, faucetReopens, fetchBrief, PermanentError, reason, requireChainId, resultMessage, Status, submitFailure, unhealthy, workerId } from "./chain.js";
import { resolveNetwork, TESTNET } from "./network.js";

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

  it("names the contract error a call reverted with, in words where it has some", () => {
    expect(reason(reverted(workerStakingAbi, "Locked", "withdraw"))).toBe('The contract function "withdraw" reverted: the stake is still locked (Locked)');
    expect(reason(reverted(workerStakingAbi, "NotHeld", "withdraw"))).toBe('The contract function "withdraw" reverted. (NotHeld)');
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
    expect(resolveNetwork({ BRAINCHAIN_RPC_URL: " \n", BRAINCHAIN_SERVICE_URL: " " })).toMatchObject({ rpc: TESTNET.rpc, service: TESTNET.service });
  });

  it("says the RPC answered when it did, and cuts the answer to one short line", () => {
    const line = reason(new HttpRequestError({ url: "https://rpc.example.com/v2/APIKEYSECRET123", details: JSON.stringify(`gateway\ttimeout ${"x".repeat(300)}`), status: 504 }));
    expect(line).toMatch(/^rpc\.example\.com answered 504 \(gateway timeout x+…\)$/);
    expect(line.length).toBe("rpc.example.com answered 504 ()".length + 160);
    expect(line).not.toMatch(/[\x00-\x1f]/);
    expect(line).not.toContain("APIKEYSECRET123");
  });

  it("takes a BrainChain service over https only, or http on this machine", () => {
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "https://brain.example.com/" }).service).toBe("https://brain.example.com");
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://127.0.0.1:3000" }).service).toBe("http://127.0.0.1:3000");
    expect(resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://localhost:3000" }).service).toBe("http://localhost:3000");
    expect(() => resolveNetwork({ BRAINCHAIN_SERVICE_URL: "http://brain.example.com" })).toThrow("https");
  });

  it("names the service's host when it fails its health check, and tells a late service from a down one", async () => {
    const service = "https://brain.example.com/v1";
    const ok = vi.fn<typeof fetch>(async () => new Response('{"ok":true}'));
    expect(await unhealthy(service, ok)).toBeUndefined();
    expect(ok.mock.calls[0]![0]).toBe("https://brain.example.com/v1/health");
    expect(await unhealthy(service, async () => new Response('{"ok":false}', { status: 503 }))).toBe(
      "the BrainChain service at brain.example.com reports it is behind (503); results still upload, and grading may be late",
    );
    expect(await unhealthy(service, async () => new Response("bad gateway", { status: 502 }))).toBe(
      "the BrainChain service at brain.example.com answered its health check with 502; results are uploaded there, so delivery can fail until it recovers",
    );
    expect(
      await unhealthy("http://localhost:1", async () => {
        throw new TypeError("fetch failed");
      }),
    ).toBe("could not reach the BrainChain service at localhost:1; results are uploaded there, so none can be delivered until it answers");
  });
});

describe("a wallet short of gas", () => {
  const plain = "The wallet holds too little ETH to pay for this transaction's gas, so it was not sent. `brainchain-worker status` shows what it holds";

  it("is said plainly, in the words of either failure", () => {
    const estimate = new BaseError("Execution reverted with reason: gas required exceeds allowance (38928).");
    expect(reason(estimate)).toBe(plain);
    const send = new BaseError("The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.", { cause: new InsufficientFundsError() });
    expect(reason(send)).toBe(plain);
  });

  it("is not confused with a token's own allowance", () => {
    expect(reason(new BaseError("ERC20: transfer amount exceeds allowance"))).toBe("ERC20: transfer amount exceeds allowance");
  });
});

describe("requireChainId", () => {
  it("refuses an RPC serving another chain, and leaves one that does not answer to the commands", async () => {
    await expect(requireChainId(TESTNET, async () => 46_630)).rejects.toThrow("BRAINCHAIN_RPC_URL serves chain 46630; BrainChain testnet is chain 274630.");
    await expect(requireChainId(TESTNET, async () => 274_630)).resolves.toBeUndefined();
    await expect(
      requireChainId(TESTNET, async () => {
        throw new Error("no answer");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("record", () => {
  it("counts a ruled or appealed task as in flight, since the stake can still be at risk", async () => {
    const account = privateKeyToAccount(`0x${"4f".repeat(32)}`);
    const id = workerId(account.address);
    const hired = encodeEventTopics({ abi: taskBoardAbi, eventName: "WorkerHired" })[0];
    const zero = `0x${"0".repeat(64)}` as const;
    let status: number = Status.Ruled;
    const answer = ({ id: rpcId, method, params }: { id: number; method: string; params: [{ topics?: unknown[] }] }) => {
      let result: unknown = "0x";
      if (method === "eth_chainId") result = "0x430c6";
      if (method === "eth_blockNumber") result = "0x1000";
      if (method === "eth_getLogs") {
        const first = params[0].topics?.[0];
        const log = { address: TESTNET.contracts.taskBoard, data: "0x", blockNumber: "0x900", transactionHash: zero, logIndex: "0x0", blockHash: zero, transactionIndex: "0x0", removed: false };
        result = (Array.isArray(first) ? first[0] : first) === hired ? [{ ...log, topics: [hired, `0x${"1".padStart(64, "0")}`, id, `0x${"1".padStart(64, "0")}`] }] : [];
      }
      if (method === "eth_call") {
        const task = {
          poster: account.address,
          bounty: 1_000_000n,
          deadline: 2_000_000_000n,
          status,
          accepted: false,
          disputed: true,
          disputedByModel: true,
          model: id,
          briefHash: zero,
          resultHash: zero,
          submittedAt: 1n,
          gradedAt: 2n,
          disputedAt: 3n,
          postedAt: 1n,
          payee: account.address,
          feeRecipient: account.address,
          feeBps: 300,
          hireThresholdBps: 1500,
          gradeThresholdBps: 8000,
          ruleThresholdBps: 8000,
          gradeWindow: 3600n,
          disputeWindow: 3600n,
          ruleWindow: 3600n,
        };
        result = encodeFunctionResult({ abi: taskBoardAbi, functionName: "get", result: task });
      }
      return { jsonrpc: "2.0", id: rpcId, result };
    };
    const rpc = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const request = JSON.parse(body) as Parameters<typeof answer>[0] | Parameters<typeof answer>[0][];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
      });
    });
    await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));
    try {
      const chain = createChain({ ...TESTNET, rpc: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}` }, account);
      for (const each of [Status.Ruled, Status.Appealed, Status.Hired, Status.Disputed]) {
        status = each;
        expect((await chain.record()).inFlight).toBe(1);
      }
      status = Status.Paid;
      expect(await chain.record()).toMatchObject({ accepted: 1, inFlight: 0 });
    } finally {
      rpc.close();
    }
  });
});

describe("answers from a real server", () => {
  const page = (title: string) => `<!doctype html>\n<html lang="en">\n\t<head><title>${title}</title></head>\x07\n${"<p>filler</p>\n".repeat(80)}</html>`;
  const json = (status: number, body: unknown) => (res: ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const html = (status: number) => (res: ServerResponse) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(page(`${status}`));
  };
  const routes: Record<string, (res: ServerResponse, req: IncomingMessage) => void> = {
    "/page200": html(200),
    "/page404": html(404),
    "/page502": html(502),
    "/page429": html(429),
    "/echo": (res, req) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`Cannot POST ${req.url}`);
    },
    "/auth": json(401, { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Must be authenticated!" } }),
    "/limit": json(429, { jsonrpc: "2.0", id: 1, error: { code: 429, message: "Your app has exceeded its compute units per second capacity" } }),
    "/rest": (res, req) => json(200, { args: {}, headers: { Authorization: req.headers.authorization }, url: `http://rest.example${req.url}` })(res),
    "/missing": json(200, { error: "Not Found" }),
    "/rpc": json(200, { jsonrpc: "2.0", id: 1, result: "0x10" }),
    "/results/html403": html(403),
    "/results/refused": json(403, { error: "Only the hired worker can upload a result" }),
  };
  const server = createServer((req, res) => {
    const route = Object.keys(routes).find((path) => req.url!.startsWith(path));
    req.resume();
    req.on("end", () => routes[route!]!(res, req));
  });
  let host = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    server.closeAllConnections();
  });

  const rpc = async (path: string) => {
    const client = createPublicClient({ transport: http(`http://${host}${path}`, { retryCount: 0 }) });
    return reason(await client.getBlockNumber().catch((error: unknown) => error));
  };

  it("says a web page that answered 200, 404 or 405 is not an RPC", async () => {
    expect(await rpc("/page200/APIKEYSECRET123")).toBe(`${host} answered, but not as an RPC`);
    expect(await rpc("/page404/APIKEYSECRET123")).toBe(`${host} answered 404 with a web page, not as an RPC`);
  });

  it("names the host when JSON that is no RPC reply answers 200, without the URL's path or credentials", async () => {
    const account = privateKeyToAccount(`0x${"4f".repeat(32)}`);
    const now = (path: string) => createChain({ ...TESTNET, rpc: `http://${host}${path}` }, account).now().catch((error: unknown) => reason(error));
    expect(await now("/rest/APIKEYSECRET123")).toBe(`${host} answered, but not as an RPC ({"args":{},"headers":{},"url":"http://rest.example…"})`);
    const echoed = await createChain({ ...TESTNET, rpc: `http://user:PASSWORDSECRET9@${host}/rest` }, account).now().catch((error: unknown) => reason(error));
    expect(echoed).toBe(`${host} answered, but not as an RPC ({"args":{},"headers":{"Authorization":"Basic …"},"url":"http://rest.example/rest"})`);
    expect(await now("/missing")).toBe(`${host} answered, but not as an RPC ({"error":"Not Found"})`);
    expect(await createChain({ ...TESTNET, rpc: `http://${host}/rpc` }, account).ethBalance()).toBe(16n);
  });

  it("keeps the status of an error page from a proxy in front of the RPC", async () => {
    expect(await rpc("/page502/APIKEYSECRET123")).toBe(`${host} answered 502 with a web page`);
    expect(await rpc("/page429")).toBe(`${host} answered 429 with a web page`);
  });

  it("names the host, the status and the provider's message when it refuses the request", async () => {
    expect(await rpc("/auth/APIKEYSECRET123")).toBe(`${host} answered 401 (Must be authenticated!)`);
    expect(await rpc("/limit")).toBe(`${host} answered 429 (Your app has exceeded its compute units per second capacity)`);
  });

  it("never prints the URL's path when an answer echoes it", async () => {
    const line = await rpc("/echo/v2/APIKEYSECRET123?key=QUERYSECRET456");
    expect(line).toBe(`${host} answered 404 (Cannot POST …)`);
    expect(await rpc("/echo/APIKEYSECRET123")).not.toContain("APIKEYSECRET123");
  });

  it("gives up on a result only when the service itself refuses it", async () => {
    const network = { ...TESTNET, service: `http://${host}/results/html403` };
    const account = privateKeyToAccount(`0x${"4f".repeat(32)}`);
    const edge = createChain(network, account).publish(7n, "work");
    await expect(edge).rejects.toThrow("Uploading the result failed (403): no reason given");
    await expect(edge).rejects.not.toBeInstanceOf(PermanentError);
    const refused = createChain({ ...network, service: `http://${host}/results/refused` }, account).publish(7n, "work");
    await expect(refused).rejects.toThrow(new PermanentError("The service refused the result (403): Only the hired worker can upload a result"));
    await expect(refused).rejects.toBeInstanceOf(PermanentError);
  });
});
