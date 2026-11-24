// What `fund --from-base` and `exit --to-base` sign, redeemed on anvil forks of Base and Robinhood Chain the way
// Relay's approval proxy redeems it: a live Relay quote for a fresh key, checked and signed as the commands do, then
// receiveWithAuthorization called from the proxy. It moves exactly the quoted amount from the key to the proxy, moves
// nothing a second time, and no other caller can redeem it. Runs with BASE_RPC and ROBINHOOD_RPC (the chains to fork) and ANVIL naming
// an anvil that can fork Robinhood Chain (1.5.0 can; 1.8 cannot). It is skipped without them.

import { spawn } from "node:child_process";

import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, parseEther, parseSignature, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { BASE } from "./base.js";
import { MAINNET } from "./network.js";
import { createPermitMover, readPermit, signPermit, type Authorization, type Origin } from "./permit.js";
import { MAX_LOSS, NATIVE } from "./relay.js";

const BASE_RPC = process.env.BASE_RPC;
const ROBINHOOD_RPC = process.env.ROBINHOOD_RPC;
const DEPOSITORY: Address = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
const eip3009 = parseAbi(["function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"]);
const RH: Origin = { chainId: 4663, name: "Robinhood Chain", token: MAINNET.bridge!.tokens!.bounty!, symbol: "USDG" };

async function onFork(rpc: string, chainId: number, port: number, run: (url: string) => Promise<void>) {
  const anvil = spawn(process.env.ANVIL ?? "anvil", ["--fork-url", rpc, "--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  try {
    const client = createPublicClient({ transport: http(url) });
    for (let tries = 0; ; tries++) {
      try {
        await client.getBlockNumber();
        break;
      } catch (error) {
        if (tries > 60) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await run(url);
  } finally {
    anvil.kill("SIGTERM");
  }
}

async function redeem(url: string, origin: Origin, destination: { chainId: number; name: string }, currency: string) {
  const fork = createPublicClient({ transport: http(url) });
  const wallet = createWalletClient({ transport: http(url) });
  const rpc = (method: string, params: unknown[]) => fork.request({ method, params } as never);
  const act = async (from: Address, call: Parameters<typeof wallet.writeContract>[0]) => {
    await rpc("anvil_impersonateAccount", [from]);
    await rpc("anvil_setBalance", [from, toHex(parseEther("1"))]);
    const hash = await wallet.writeContract({ ...call, account: from, chain: null } as never);
    return fork.waitForTransactionReceipt({ hash });
  };
  const balance = (owner: Address) => fork.readContract({ address: origin.token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

  const key = privateKeyToAccount(generatePrivateKey());
  const amount = 5_000_000n;
  await act(DEPOSITORY, { address: origin.token, abi: erc20Abi, functionName: "transfer", args: [key.address, amount] } as never);
  expect(await balance(key.address)).toBe(amount);

  const mover = createPermitMover({ account: key, origin, destination, again: "fork", maxLoss: () => MAX_LOSS });
  const quote = await mover.preview(currency, amount, key.address);
  const authorization = readPermit(quote, { owner: key.address, origin, amount, recipient: key.address, currency, destination, now: Math.floor(Date.now() / 1000) }) as Authorization;
  expect(typeof authorization).toBe("object");
  const { r, s, v } = parseSignature(await signPermit(key, authorization));
  const m = authorization.message;
  const call = { address: origin.token, abi: eip3009, functionName: "receiveWithAuthorization", args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, Number(v), r, s] } as never;

  const proxyBefore = await balance(m.to);
  const outcome = async (from: Address) => (await act(from, call).catch(() => undefined))?.status ?? "refused";
  const moved = async () => [await balance(key.address), (await balance(m.to)) - proxyBefore];

  // Only the payee the authorization names can redeem it.
  expect(await outcome(DEPOSITORY)).not.toBe("success");
  expect(await moved()).toEqual([amount, 0n]);
  expect(await outcome(m.to)).toBe("success");
  expect(await moved()).toEqual([0n, amount]);
  // A second redemption moves nothing: USDC reverts it, and USDG's ends without a transfer.
  await outcome(m.to);
  expect(await moved()).toEqual([0n, amount]);
}

describe.skipIf(!BASE_RPC || !ROBINHOOD_RPC)("Relay's authorization on forks", () => {
  it("fund --from-base: Relay's proxy can take exactly the quoted USDC on Base, once", () =>
    onFork(BASE_RPC!, BASE.chainId, 8562, (url) => redeem(url, BASE, { chainId: 4663, name: "Robinhood Chain" }, NATIVE)), 120_000);

  it("exit --to-base: Relay's proxy can take exactly the quoted USDG on Robinhood Chain, once", () =>
    onFork(ROBINHOOD_RPC!, RH.chainId, 8563, (url) => redeem(url, RH, { chainId: BASE.chainId, name: "Base" }, BASE.token)), 120_000);
});
