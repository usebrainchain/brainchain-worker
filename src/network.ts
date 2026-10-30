import { defineChain, type Address } from "viem";

export interface Network {
  name: string;
  chainId: number;
  rpc: string;
  /** The BrainChain service, which keeps a worker's result private until Jev accepts it. */
  service: string;
  /** First block of the deployment, where event scans start. */
  fromBlock: bigint;
  explorer: string;
  stakeSymbol: string;
  bountySymbol: string;
  contracts: {
    taskBoard: Address;
    staking: Address;
    bonds: Address;
    executor: Address;
    stakeToken: Address;
    bountyToken: Address;
  };
}

/** BrainChain testnet, release 3.1.0. Mainnet has no open staking yet. */
export const TESTNET: Network = {
  name: "BrainChain testnet",
  chainId: 274630,
  rpc: "https://rpc.testnet.usebrainchain.com",
  service: "https://brain.testnet.usebrainchain.com",
  fromBlock: 898n,
  explorer: "https://usebrainchain.com/testnet",
  stakeSymbol: "tBRAIN",
  bountySymbol: "tUSDG",
  contracts: {
    taskBoard: "0xC74564F100e70F95346A6e399ebf1Ce14309C8B6",
    staking: "0xbdC08799D865DA79FE44a469de1FeaE84bb45059",
    bonds: "0x574060D1A7CA8f3786d2D14fe1A782cc4638CB1e",
    executor: "0x420484B139001ED5B1DA330e689Cc2f4814001Fb",
    stakeToken: "0xc717546497343911750768335b649b86d0a6eCcf",
    bountyToken: "0xC4ec72794bF3Ce9ba1DE4B38085464c2eb0cDCf2",
  },
};

export function resolveNetwork(env: NodeJS.ProcessEnv): Network {
  const name = (env.BRAINCHAIN_NETWORK?.trim() || "testnet").toLowerCase();
  if (name === "mainnet") throw new Error("Outside workers run on BrainChain testnet for now. Unset BRAINCHAIN_NETWORK or set it to testnet.");
  if (name !== "testnet") throw new Error(`BRAINCHAIN_NETWORK must be testnet, not "${env.BRAINCHAIN_NETWORK}"`);
  return {
    ...TESTNET,
    ...(env.BRAINCHAIN_RPC_URL ? { rpc: env.BRAINCHAIN_RPC_URL } : {}),
    ...(env.BRAINCHAIN_SERVICE_URL ? { service: env.BRAINCHAIN_SERVICE_URL.replace(/\/$/, "") } : {}),
  };
}

export function chainOf(network: Network) {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [network.rpc] } },
  });
}
