import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createPublicClient, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import { brainchainTransport, reason } from "./chain.js";
import { MAINNET, proofsTransport, resolveNetwork, rpcTransport, TESTNET } from "./network.js";

const mainnet = { BRAINCHAIN_NETWORK: "mainnet" };

describe("resolveNetwork", () => {
  it("keeps testnet the default", () => {
    expect(resolveNetwork({})).toEqual(TESTNET);
    expect(resolveNetwork({ BRAINCHAIN_NETWORK: " Testnet " })).toEqual(TESTNET);
  });

  it("resolves mainnet to the 3.6.0 set, which stakes the BRAIN of the move", () => {
    const network = resolveNetwork(mainnet);
    expect(network).toMatchObject({
      name: "BrainChain",
      chainId: 274663,
      rpc: "https://rpc.usebrainchain.com",
      service: "https://brain.usebrainchain.com",
      fromBlock: 2787n,
      explorer: "https://usebrainchain.com",
      stakeSymbol: "BRAIN",
      bountySymbol: "USDG",
    });
    expect(network.contracts).toEqual({
      taskBoard: "0xf72857aABB25Fe1393b57d2356A090A7000ED13e",
      staking: "0x1FD895474772081B20914839a9dD9042bCB60Ff0",
      bonds: "0xfEFE2AEd07a28792fe395B07235c3d949be808f0",
      executor: "0x0eDd6c7dC362BC8ee4601A09d72eB7c651FcD88f",
      gate: "0x3e5e23a5fF6548958ab3dDf42c51A59713cE550C",
      registry: "0xceF60eE00778ba0d7511c13f2c2F26333Eb22acb",
      stakeToken: "0x1d909E933A7743b29e13387fB34cB29608c3833F",
      bountyToken: "0x8eBFEce96c0AeF7Fd23425D846a302a552c8c451",
      log: "0x53e0137e45C8bAc1018802aD36060cDda3B159F0",
    });
    expect(network.bridge?.tokens).toEqual({ stake: "0x42b96dbc55e79E930d866c1eE486A342366546BC", bounty: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" });
    expect(network.retired?.map((r) => [r.release, r.taskBoard, r.staking])).toEqual([
      ["3.5.0", "0x44b8464342Bbfb9B565FAE494DfDefa37D33A211", "0xa4351E2b84eb634E93D9082907B2d0D3Aa91B98F"],
      ["3.4.0", "0x8385bb4b8990411CcdD8e851B2676da1A4C1f3C4", "0x21Fe66c04da07f85D855E9920251Df7d584c3D9F"],
      ["3.3.0", "0x72C890AA996bF7efcA88e3F5063B626560215160", "0x0fb02559e704549794EdF3FBBBe91DB88bB849ee"],
    ]);
    expect(network.zerox).toEqual({
      quote: "https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote/",
      payment: { chainId: 8453, name: "Base", rpc: "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", price: 10_000n },
    });
    expect(network.proofs).toEqual({
      chainId: 4663,
      name: "Robinhood Chain",
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      rpcFallbacks: ["https://rpc-robinhood.globalstake.io", "https://robinhood.api.pocket.network"],
      collection: "0xE6E6B7DBF1a66dFB25c6F6A87a916B3186113169",
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      gas: "Send it a little ETH there for gas",
      income: "0xeb1b4168D4b87D3d9F0D64E13B7071251BBB63b7",
      bonds: {
        registry: "0xD5Da523ee49CB7Fe855B0C6fa38707190A9D531F",
        check: "0x2e7C4F0F2e6079C3B5F7Cd2440308234CBDc537D",
        proofIndex: "0x0fb02559e704549794EdF3FBBBe91DB88bB849ee",
        usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      },
    });
    expect(resolveNetwork({ BRAINCHAIN_NETWORK: "MAINNET" })).toEqual(MAINNET);
  });

  it("refuses mainnet while any of its contracts is the zero address", () => {
    for (const contract of ["taskBoard", "staking", "bonds", "executor"] as const) {
      const unfinished = { ...MAINNET, contracts: { ...MAINNET.contracts, [contract]: zeroAddress } };
      expect(() => resolveNetwork(mainnet, unfinished)).toThrow("BrainChain mainnet is not open to outside workers yet");
      expect(resolveNetwork({}, unfinished)).toEqual(TESTNET);
    }
  });

  it("takes the RPC and service overrides on mainnet too", () => {
    const network = resolveNetwork({ ...mainnet, BRAINCHAIN_RPC_URL: "https://rpc.example.com/v2/key", BRAINCHAIN_SERVICE_URL: "https://brain.example.com/" });
    expect(network).toMatchObject({ chainId: 274663, rpc: "https://rpc.example.com/v2/key", service: "https://brain.example.com" });
  });

  it("names the networks it knows", () => {
    expect(() => resolveNetwork({ BRAINCHAIN_NETWORK: "devnet" })).toThrow('BRAINCHAIN_NETWORK must be testnet or mainnet, not "devnet"');
  });

  it("gives testnet a faucet and mainnet a place to buy the stake token", () => {
    expect(TESTNET.buyStake).toBeUndefined();
    expect(TESTNET.proofs.income).toBeUndefined();
    expect(TESTNET.proofs).toMatchObject({ chainId: 46630, collection: "0x324B52EE2182641ec29652076ab541bc9F9907d2", weth: "0x1F852eF3Afa13156b807204d838BbB46B4b452eb", faucet: true });
    expect(MAINNET.proofs.faucet).toBeUndefined();
    expect(MAINNET.buyStake).toContain("https://ripples.run/t/0x8D7dAC20bc8e3E6C5ad0ca07A1F00a4Ecd4e35C9");
    expect(TESTNET.zerox).toBeUndefined();
  });
});

describe("the desk exit pays", () => {
  it("is pinned on both networks: the testnet service names it, and on mainnet it is the poster of tasks paid through the desk", () => {
    expect(TESTNET.exitDesk).toBe("0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1");
    expect(MAINNET.exitDesk).toBe("0x97D558417c3D61f1074422AD843e1Db1E565b952");
  });
});

describe("rpcTransport", () => {
  it("waits 10 seconds for an answer and tries a failed request once more, on every chain the worker reads", () => {
    for (const transport of [rpcTransport("https://rpc.example"), brainchainTransport(TESTNET)]) {
      expect(transport({}).config).toMatchObject({ timeout: 10_000, retryCount: 1 });
    }
    const proofs = (fallbacks: string[]) => (proofsTransport({ ...TESTNET.proofs, rpcFallbacks: fallbacks })({}).value as { transports: { config: object }[] }).transports;
    expect(proofs([])[0]!.config).toMatchObject({ timeout: 10_000, retryCount: 1 });
    // With fallbacks, the next RPC is the retry.
    expect(proofs(["https://rpc.example"]).map((t) => t.config)).toMatchObject([{ timeout: 10_000, retryCount: 0 }, { timeout: 10_000, retryCount: 0 }]);
  });

  it("gives up after the one retry and names the host", async () => {
    let requests = 0;
    const server = createServer((_, response) => {
      requests += 1;
      response.writeHead(503).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const error = await createPublicClient({ transport: rpcTransport(`http://${host}`) }).getChainId().catch((e: unknown) => e);
      expect(reason(error)).toContain(`${host} answered 503`);
      expect(requests).toBe(2);
    } finally {
      server.close();
    }
  });
});
