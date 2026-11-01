import { defineChain, fallback, http, zeroAddress, type Address } from "viem";

export interface Network {
  /** As BRAINCHAIN_NETWORK names it, and the worker's files on this network. */
  id: "testnet" | "mainnet";
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
  /** How the worker's wallet gets ETH for gas. */
  gas: string;
  /** Where to get the stake token when it has no faucet. */
  buyStake?: string;
  /**
   * The chain the Proofs live on: the collection every paid task becomes a
   * piece of, the WETH a piece is paid for in, and the router that pays the
   * pieces' income where there is one.
   */
  proofs: {
    chainId: number;
    name: string;
    rpc: string;
    /** Read in order when the RPC before fails to answer. */
    rpcFallbacks?: string[];
    collection: Address;
    weth: Address;
    /** Set where the WETH has a faucet, as test WETH does. */
    faucet?: true;
    /** How the wallet gets ETH there for gas, said after what it holds there. */
    gas: string;
    income?: Address;
  };
  contracts: {
    taskBoard: Address;
    staking: Address;
    bonds: Address;
    executor: Address;
    /** The model registry, the third contract a change can call. */
    registry: Address;
    stakeToken: Address;
    bountyToken: Address;
  };
}

/** BrainChain testnet, release 3.1.0. */
export const TESTNET: Network = {
  id: "testnet",
  name: "BrainChain testnet",
  chainId: 274630,
  rpc: "https://rpc.testnet.usebrainchain.com",
  service: "https://brain.testnet.usebrainchain.com",
  fromBlock: 898n,
  explorer: "https://usebrainchain.com/testnet",
  stakeSymbol: "tBRAIN",
  bountySymbol: "tUSDG",
  gas: "Get Robinhood Chain testnet ETH from https://faucet.testnet.chain.robinhood.com and bridge some at https://usebrainchain.com/testnet",
  proofs: {
    chainId: 46630,
    name: "Robinhood Chain testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    rpcFallbacks: ["https://robinhood-sepolia-rpc.publicnode.com", "https://robinhood-testnet.drpc.org"],
    collection: "0x324B52EE2182641ec29652076ab541bc9F9907d2",
    weth: "0x1F852eF3Afa13156b807204d838BbB46B4b452eb",
    faucet: true,
    gas: "Get Robinhood Chain testnet ETH for gas at https://faucet.testnet.chain.robinhood.com",
  },
  contracts: {
    taskBoard: "0xC74564F100e70F95346A6e399ebf1Ce14309C8B6",
    staking: "0xbdC08799D865DA79FE44a469de1FeaE84bb45059",
    bonds: "0x574060D1A7CA8f3786d2D14fe1A782cc4638CB1e",
    executor: "0x420484B139001ED5B1DA330e689Cc2f4814001Fb",
    registry: "0x297AA5fb95Ef9785Da6DC0cA00121060606e2C63",
    stakeToken: "0xc717546497343911750768335b649b86d0a6eCcf",
    bountyToken: "0xC4ec72794bF3Ce9ba1DE4B38085464c2eb0cDCf2",
  },
};

// The 3.3.0 set. Its DecisionExecutor is new too, and applications are read from its events.
export const MAINNET_TASK_BOARD: Address = "0x72C890AA996bF7efcA88e3F5063B626560215160";
export const MAINNET_WORKER_STAKING: Address = "0x0fb02559e704549794EdF3FBBBe91DB88bB849ee";
export const MAINNET_PROPOSAL_BONDS: Address = "0x3806b71D46cd74d0Ac4BBC34577f311A0Fd06D14";
export const MAINNET_DECISION_EXECUTOR: Address = "0xA03614B09Dcc3813eD665a1693123f2a4f2C2483";

const BRAIN: Address = "0x3367085Eb6C79BfB0fCa4f1433ec77bFA8CB8a37";

/** BrainChain mainnet, release 3.3.0. */
export const MAINNET: Network = {
  id: "mainnet",
  name: "BrainChain",
  chainId: 274663,
  rpc: "https://rpc.usebrainchain.com",
  service: "https://brain.usebrainchain.com",
  fromBlock: 425n,
  explorer: "https://usebrainchain.com",
  stakeSymbol: "BRAIN",
  bountySymbol: "USDG",
  gas: "Bridge some from Robinhood Chain at https://usebrainchain.com/network",
  buyStake:
    "Buy BRAIN on ripples.run (https://ripples.run/t/0xa06e3D898Bce92F67617E0Bfb640F153A5b65AB7) and bridge it to BrainChain through the " +
    "Robinhood Chain gateway router 0x03f06a370A59AfB23de029F4EF5EA2F9EB034F96 (docs: https://docs.usebrainchain.com/bridging); " +
    `the stake token on BrainChain is ${BRAIN}.`,
  proofs: {
    chainId: 4663,
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    rpcFallbacks: ["https://rpc-robinhood.globalstake.io", "https://robinhood.api.pocket.network"],
    collection: "0xE6E6B7DBF1a66dFB25c6F6A87a916B3186113169",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    gas: "Send it a little ETH there for gas",
    income: "0xeb1b4168D4b87D3d9F0D64E13B7071251BBB63b7",
  },
  contracts: {
    taskBoard: MAINNET_TASK_BOARD,
    staking: MAINNET_WORKER_STAKING,
    bonds: MAINNET_PROPOSAL_BONDS,
    executor: MAINNET_DECISION_EXECUTOR,
    registry: "0x65B71706bE8a92dda39dDfdb6ABA8CEA64A33865",
    stakeToken: BRAIN,
    bountyToken: "0x8eBFEce96c0AeF7Fd23425D846a302a552c8c451",
  },
};

export function resolveNetwork(env: NodeJS.ProcessEnv, mainnet = MAINNET): Network {
  const name = (env.BRAINCHAIN_NETWORK?.trim() || "testnet").toLowerCase();
  if (name !== "testnet" && name !== "mainnet") throw new Error(`BRAINCHAIN_NETWORK must be testnet or mainnet, not "${env.BRAINCHAIN_NETWORK}"`);
  const { taskBoard, staking, bonds, executor } = mainnet.contracts;
  // A set not yet deployed is left at the zero address, and the worker must never send to it.
  if (name === "mainnet" && [taskBoard, staking, bonds, executor].includes(zeroAddress)) {
    throw new Error("BrainChain mainnet is not open to outside workers yet. Unset BRAINCHAIN_NETWORK to work on testnet.");
  }
  // Blank counts as unset, as for BRAINCHAIN_NETWORK.
  const rpc = env.BRAINCHAIN_RPC_URL?.trim();
  const service = env.BRAINCHAIN_SERVICE_URL?.trim();
  return { ...(name === "mainnet" ? mainnet : TESTNET), ...(rpc ? { rpc: rpcURL(rpc) } : {}), ...(service ? { service: serviceURL(service) } : {}) };
}

/** The value is never echoed: an RPC URL can hold an API key, and a mistyped one still does. */
function rpcURL(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== "https:" && url?.protocol !== "http:") throw new Error("BRAINCHAIN_RPC_URL is not a valid URL: it must start with https:// or http://");
  return value;
}

/** The worker signs and sends its results to the service, so only https is accepted, or plain http to a service on this machine. */
function serviceURL(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  const local = url?.hostname === "localhost" || url?.hostname === "127.0.0.1";
  if (url?.protocol !== "https:" && !(url?.protocol === "http:" && local)) {
    throw new Error("BRAINCHAIN_SERVICE_URL must be an https URL, or http on localhost or 127.0.0.1");
  }
  return value.replace(/\/+$/, "");
}

export function chainOf(network: Network) {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [network.rpc] } },
  });
}

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export function proofsChainOf(proofs: Network["proofs"]) {
  return defineChain({
    id: proofs.chainId,
    name: proofs.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [proofs.rpc, ...(proofs.rpcFallbacks ?? [])] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

/** The Proofs chain's RPCs in order; the next answers when one fails to, a revert being an answer. */
export function proofsTransport(proofs: Network["proofs"]) {
  const urls = [proofs.rpc, ...(proofs.rpcFallbacks ?? [])];
  return fallback(urls.map((url) => http(url, { timeout: 20_000, retryCount: urls.length > 1 ? 1 : 3 })), { rank: false, retryCount: 0 });
}
