import { defineChain, fallback, http, zeroAddress, type Address, type HttpTransportConfig } from "viem";

import { cli } from "./invoked.js";

export interface Network {
  /** As BRAINCHAIN_NETWORK names it, and the worker's files on this network. */
  id: "testnet" | "mainnet";
  /** The contract set this release stakes on. */
  release: string;
  name: string;
  chainId: number;
  rpc: string;
  /** The BrainChain service, which keeps a worker's results and publishes each once Jev accepts it, or grades it for a house task. */
  service: string;
  /** First block of the deployment, where event scans start. */
  fromBlock: bigint;
  explorer: string;
  stakeSymbol: string;
  bountySymbol: string;
  /** Set where the bounty token has a faucet, as test USDG does, rather than being bridged in. */
  bountyFaucet?: true;
  /** How the worker's wallet gets ETH for gas. */
  gas: string;
  /**
   * Testnet's gas drip, which needs no browser, so an agent can fund itself. It
   * sends `wei` once per address and turns away an address that holds that much.
   */
  drip?: { wei: bigint; request: (address: string) => string };
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
    /**
     * Delivery bonds on Shipped's registry there: the registry, its on-chain
     * check, the bond asset, and BrainChain's ProofIndex once it is deployed.
     * Absent where Shipped has no registry.
     */
    bonds?: {
      registry: Address;
      check: Address;
      proofIndex?: Address;
      usdg: Address;
    };
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
    /** The decision log, which `watch` re-verifies decisions from. */
    log: Address;
    /** The guardian gate a watcher vetoes through, on sets that have one. */
    gate?: Address;
  };
  /** The desk `exit` pays on BrainChain. Pinned here, since the service only names it and a transfer to the wrong address is gone. */
  exitDesk: Address;
  /**
   * The USDG the desk takes over x402 on the parent chain, at the same address: how a sitting of the licence exam
   * is paid. A payment in it moves through Permit2. Pinned here, so the worker signs for no other token.
   */
  deskUsdg: { address: Address; symbol: string };
  /** Earlier sets. A wallet can still hold stake on their contracts and bonds on their boards' tasks, and task ids restart with each board. */
  retired?: { release: string; taskBoard: Address; staking: Address }[];
  /** The ERC-8004 identity registry on the parent chain, where `join --agent-id` checks the wallet holds the agent; mainnet only. */
  identity?: Address;
  /**
   * Contracts on the parent chain that own an id on behalf of the NFT it is bound to. An id one of them owns is
   * held by that NFT's holder alone, as the service reads it.
   */
  identityAdapters?: Address[];
  /** Priors' credit pool and BrainChain's root identity in it, where `credit` signs its consent; mainnet only. */
  priors?: { pool: Address; root: bigint };
  /** The parent chain and its bridge contracts, where `bridge` moves funds in from. */
  bridge?: {
    chainId: number;
    name: string;
    rpc: string;
    inbox: Address;
    router: Address;
    /** How the wallet gets ETH there. */
    gas: string;
    /** The stake and bounty tokens on the parent chain; absent where the token is minted on BrainChain only. */
    tokens?: Partial<Record<"stake" | "bounty", Address>>;
  };
  /**
   * Where `buy-stake` buys the stake token on the parent chain: 0x's keyless
   * gateway, which the worker pays per quote in USDC on Base from its own key.
   */
  zerox?: {
    /** The exact-out price that estimates the sale, then the exact-in quote that is sent. */
    price: string;
    quote: string;
    payment: { chainId: number; name: string; rpc: string; usdc: Address; price: bigint };
  };
}

/** BrainChain testnet, release 3.5.0. */
export const TESTNET: Network = {
  id: "testnet",
  release: "3.5.0",
  name: "BrainChain testnet",
  chainId: 274630,
  rpc: "https://rpc.testnet.usebrainchain.com",
  service: "https://brain.testnet.usebrainchain.com",
  fromBlock: 2288n,
  explorer: "https://usebrainchain.com/testnet",
  stakeSymbol: "tBRAIN",
  bountySymbol: "tUSDG",
  bountyFaucet: true,
  gas:
    "Get Robinhood Chain testnet ETH from https://faucet.testnet.chain.robinhood.com, which asks for a browser check and a Google account, " +
    `so a person claims it, and move it here with ${cli("bridge --eth 0.001")}`,
  drip: {
    wei: 100_000_000_000_000n,
    request: (address) => `\`curl -X POST https://brain.testnet.usebrainchain.com/testnet/gas -H 'content-type: application/json' -d '{"address":"${address}"}'\``,
  },
  proofs: {
    chainId: 46630,
    name: "Robinhood Chain testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    rpcFallbacks: ["https://robinhood-sepolia-rpc.publicnode.com", "https://robinhood-testnet.drpc.org"],
    collection: "0x324B52EE2182641ec29652076ab541bc9F9907d2",
    weth: "0x1F852eF3Afa13156b807204d838BbB46B4b452eb",
    faucet: true,
    // The gas drip funds BrainChain testnet only, and this faucet asks for a browser check, so a person has to claim it.
    gas:
      "A person can get Robinhood Chain testnet ETH for gas at https://faucet.testnet.chain.robinhood.com, which asks for a browser check and a Google account, " +
      "and send it to this address; BrainChain's gas drip sends ETH on BrainChain testnet only",
  },
  bridge: {
    chainId: 46630,
    name: "Robinhood Chain testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    inbox: "0xd5B98547aA58db0AbC75C06f5A62a7ACDF9CB977",
    router: "0x1BBe71Dd3af85309A5c7Ab00B190F38f34Fe3569",
    gas: "Get Robinhood Chain testnet ETH at https://faucet.testnet.chain.robinhood.com",
  },
  exitDesk: "0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1",
  deskUsdg: { address: "0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787", symbol: "test USDG" },
  contracts: {
    taskBoard: "0x7A7cC5D35A642CCc268C7B263fF800bc7eBD52A4",
    staking: "0x6aFC3EFB49CF9b14C2F7c6C4f6C0bb3eF0125e2b",
    bonds: "0x2f15B42131544e6763dbECC7C954C7823AAa0D47",
    executor: "0xA3a40A2D46D54dc6e88c08a9d98Ec47785CB2366",
    registry: "0x3e5e23a5fF6548958ab3dDf42c51A59713cE550C",
    log: "0x4E4cB48f3802bD519E0Eed896dF82197B0ecBc09",
    gate: "0x84d01e0869fbCb07c0141E49c390ffdc064D6882",
    stakeToken: "0xc717546497343911750768335b649b86d0a6eCcf",
    bountyToken: "0xC4ec72794bF3Ce9ba1DE4B38085464c2eb0cDCf2",
  },
};

// The 3.6.0 set, whose staking and bonds take the BRAIN of the 17 November move.
const MAINNET_TASK_BOARD: Address = "0xf72857aABB25Fe1393b57d2356A090A7000ED13e";
const MAINNET_WORKER_STAKING: Address = "0x1FD895474772081B20914839a9dD9042bCB60Ff0";
const MAINNET_PROPOSAL_BONDS: Address = "0xfEFE2AEd07a28792fe395B07235c3d949be808f0";
const MAINNET_DECISION_EXECUTOR: Address = "0x0eDd6c7dC362BC8ee4601A09d72eB7c651FcD88f";

/** BRAIN on BrainChain, and on Robinhood Chain, where the bridge's router maps the one to the other. */
const BRAIN: Address = "0x1d909E933A7743b29e13387fB34cB29608c3833F";
const PARENT_BRAIN: Address = "0x42b96dbc55e79E930d866c1eE486A342366546BC";

/** BrainChain mainnet, release 3.6.0. */
export const MAINNET: Network = {
  id: "mainnet",
  release: "3.6.0",
  name: "BrainChain",
  chainId: 274663,
  rpc: "https://rpc.usebrainchain.com",
  service: "https://brain.usebrainchain.com",
  fromBlock: 2787n,
  explorer: "https://usebrainchain.com",
  stakeSymbol: "BRAIN",
  bountySymbol: "USDG",
  gas: `Send this address ETH on Robinhood Chain, then move it here with ${cli("bridge --eth 0.001")}`,
  buyStake:
    "Buy BRAIN on Robinhood Chain at ripples.run (https://ripples.run/t/0x8D7dAC20bc8e3E6C5ad0ca07A1F00a4Ecd4e35C9) and move it to BrainChain with " +
    `${cli("bridge --stake <amount>")} (docs: https://docs.usebrainchain.com/bridging); BRAIN is ${PARENT_BRAIN} on Robinhood Chain and ${BRAIN} on BrainChain.`,
  proofs: {
    chainId: 4663,
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    rpcFallbacks: ["https://rpc-robinhood.globalstake.io", "https://robinhood.api.pocket.network"],
    collection: "0xE6E6B7DBF1a66dFB25c6F6A87a916B3186113169",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    gas: "Send it a little ETH there for gas",
    income: "0xeb1b4168D4b87D3d9F0D64E13B7071251BBB63b7",
    // Shipped's registry and StaticCallCheck, and BrainChain's ProofIndex the check reads.
    bonds: {
      registry: "0xD5Da523ee49CB7Fe855B0C6fa38707190A9D531F",
      check: "0x2e7C4F0F2e6079C3B5F7Cd2440308234CBDc537D",
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      proofIndex: "0x0fb02559e704549794EdF3FBBBe91DB88bB849ee",
    },
  },
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  identityAdapters: ["0x000000009d62675362a58911e3f32FEcf46F5E18"],
  priors: { pool: "0x281210097f0de7A8FB6F87310AF0f089c9C8DE21", root: 20423n },
  bridge: {
    chainId: 4663,
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    inbox: "0x139a54F81d6Fdf7135D633CBCfB2373F0edfa2dd",
    router: "0x03f06a370A59AfB23de029F4EF5EA2F9EB034F96",
    gas: "Send it a little ETH on Robinhood Chain",
    tokens: { stake: PARENT_BRAIN, bounty: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  },
  zerox: {
    price: "https://agent.api.0x.org/v1/x402/swap-allowance-holder-price/",
    quote: "https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote/",
    payment: { chainId: 8453, name: "Base", rpc: "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", price: 10_000n },
  },
  exitDesk: "0x97D558417c3D61f1074422AD843e1Db1E565b952",
  deskUsdg: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG" },
  retired: [
    // Its staking and bonds hold the BRAIN from before the move.
    { release: "3.5.0", taskBoard: "0x44b8464342Bbfb9B565FAE494DfDefa37D33A211", staking: "0xa4351E2b84eb634E93D9082907B2d0D3Aa91B98F" },
    { release: "3.4.0", taskBoard: "0x8385bb4b8990411CcdD8e851B2676da1A4C1f3C4", staking: "0x21Fe66c04da07f85D855E9920251Df7d584c3D9F" },
    { release: "3.3.0", taskBoard: "0x72C890AA996bF7efcA88e3F5063B626560215160", staking: "0x0fb02559e704549794EdF3FBBBe91DB88bB849ee" },
  ],
  contracts: {
    taskBoard: MAINNET_TASK_BOARD,
    staking: MAINNET_WORKER_STAKING,
    bonds: MAINNET_PROPOSAL_BONDS,
    executor: MAINNET_DECISION_EXECUTOR,
    registry: "0xceF60eE00778ba0d7511c13f2c2F26333Eb22acb",
    log: "0x53e0137e45C8bAc1018802aD36060cDda3B159F0",
    gate: "0x3e5e23a5fF6548958ab3dDf42c51A59713cE550C",
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

export function parentChainOf(bridge: NonNullable<Network["bridge"]>) {
  return defineChain({
    id: bridge.chainId,
    name: bridge.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [bridge.rpc] } },
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

/** How long any RPC request waits for an answer before it is tried again, once, or fails. */
const RPC_TIMEOUT_MS = 10_000;

/** An RPC that does not answer fails a command in about 20 seconds, naming its host, rather than holding it in silence. */
export const rpcTransport = (url: string, config: Omit<HttpTransportConfig, "timeout" | "retryCount"> = {}) => http(url, { ...config, timeout: RPC_TIMEOUT_MS, retryCount: 1 });

/** The Proofs chain's RPCs in order; the next answers when one fails to, a revert being an answer. */
export function proofsTransport(proofs: Network["proofs"]) {
  const urls = [proofs.rpc, ...(proofs.rpcFallbacks ?? [])];
  // Each fallback is the retry where there are several.
  return fallback(urls.map((url) => http(url, { timeout: RPC_TIMEOUT_MS, retryCount: urls.length > 1 ? 0 : 1 })), { rank: false, retryCount: 0 });
}
