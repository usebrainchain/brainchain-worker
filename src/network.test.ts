import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import { MAINNET, resolveNetwork, TESTNET } from "./network.js";

const mainnet = { BRAINCHAIN_NETWORK: "mainnet" };

describe("resolveNetwork", () => {
  it("keeps testnet the default", () => {
    expect(resolveNetwork({})).toEqual(TESTNET);
    expect(resolveNetwork({ BRAINCHAIN_NETWORK: " Testnet " })).toEqual(TESTNET);
  });

  it("resolves mainnet to the 3.4.0 set", () => {
    const network = resolveNetwork(mainnet);
    expect(network).toMatchObject({
      name: "BrainChain",
      chainId: 274663,
      rpc: "https://rpc.usebrainchain.com",
      service: "https://brain.usebrainchain.com",
      fromBlock: 839n,
      explorer: "https://usebrainchain.com",
      stakeSymbol: "BRAIN",
      bountySymbol: "USDG",
    });
    expect(network.contracts).toEqual({
      taskBoard: "0x8385bb4b8990411CcdD8e851B2676da1A4C1f3C4",
      staking: "0x21Fe66c04da07f85D855E9920251Df7d584c3D9F",
      bonds: "0x1129435A110AB3Ffd3fFEE345A48f648DdE3D52c",
      executor: "0x98BEA2E455539dB38b7337d81C673326128EA17F",
      gate: "0x48c2Ed99Dc786ba667eFcFF721ff4cA92a1f344A",
      registry: "0x870B0BFB24aF2C06180FbEe266117305e0B0E00F",
      stakeToken: "0x3367085Eb6C79BfB0fCa4f1433ec77bFA8CB8a37",
      bountyToken: "0x8eBFEce96c0AeF7Fd23425D846a302a552c8c451",
      log: "0xFdFEDb376c9632A4D6F15a1697E2b6853f12B4d7",
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
    expect(MAINNET.buyStake).toContain("https://ripples.run/t/0xa06e3D898Bce92F67617E0Bfb640F153A5b65AB7");
  });
});
