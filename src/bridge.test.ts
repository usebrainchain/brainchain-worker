import { parseEther, parseUnits, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { bridge, type Asset, type BridgeChain } from "./bridge.js";
import { MAINNET, TESTNET } from "./network.js";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000C1";
const TX: Hex = `0x${"fe".repeat(32)}`;

function fakeChain(options: { eth?: bigint; stake?: bigint; bounty?: bigint; cost?: bigint } = {}) {
  const sent: string[] = [];
  const chain: BridgeChain = {
    account: ACCOUNT,
    parentEth: vi.fn(async () => options.eth ?? parseEther("0.01")),
    tokenBalance: vi.fn(async (asset: Exclude<Asset, "eth">) => (asset === "stake" ? (options.stake ?? parseEther("2000000")) : (options.bounty ?? parseUnits("50", 6)))),
    arrivalCost: vi.fn(async () => options.cost ?? parseEther("0.0003")),
    depositEth: vi.fn(async (amount: bigint) => {
      sent.push(`eth ${amount}`);
      return TX;
    }),
    depositToken: vi.fn(async (asset: Exclude<Asset, "eth">, amount: bigint, value: bigint) => {
      sent.push(`${asset} ${amount} value ${value}`);
      return TX;
    }),
  };
  return { chain, sent };
}

async function run(chain: BridgeChain, asset: Asset, amount: string, dry = false, network = MAINNET) {
  const lines: string[] = [];
  await bridge(network, chain, { asset, amount, dry, log: (line) => lines.push(line) });
  return lines;
}

describe("bridge", () => {
  it("deposits ETH through the inbox and says when it arrives", async () => {
    const { chain, sent } = fakeChain();
    const lines = await run(chain, "eth", "0.001");
    expect(sent).toEqual([`eth ${parseEther("0.001")}`]);
    expect(lines).toEqual([
      `bridging 0.001 ETH from Robinhood Chain to ${ACCOUNT} on BrainChain`,
      `sent, arrives on BrainChain in about a minute: ${TX}`,
    ]);
  });

  it("deposits the stake token with the ETH its arrival costs", async () => {
    const { chain, sent } = fakeChain({ cost: parseEther("0.0003") });
    const lines = await run(chain, "stake", "1250000");
    expect(sent).toEqual([`stake ${parseEther("1250000")} value ${parseEther("0.0003")}`]);
    expect(lines[0]).toBe(`bridging 1,250,000 BRAIN from Robinhood Chain to ${ACCOUNT} on BrainChain (sending 0.0003 ETH for its arrival, the unused part refunded there)`);
  });

  it("takes bounty amounts in 6 decimals and sends nothing on a dry run", async () => {
    const { chain, sent } = fakeChain();
    const lines = await run(chain, "bounty", "12.5", true);
    expect(sent).toEqual([]);
    expect(lines[0]).toContain("bridging 12.5 USDG");
    expect(lines[1]).toBe("dry run: nothing sent");
  });

  it("says exactly what the wallet lacks, and sends nothing", async () => {
    const short = fakeChain({ stake: parseEther("1000") });
    await expect(run(short.chain, "stake", "1250000")).rejects.toThrow(`${ACCOUNT} holds 1,000 BRAIN on Robinhood Chain, 1,249,000 short of 1,250,000 BRAIN`);
    const noGas = fakeChain({ eth: parseEther("0.0001") });
    await expect(run(noGas.chain, "bounty", "1")).rejects.toThrow(/holds 0.0001 ETH on Robinhood Chain; about 0.0004 ETH is needed/);
    await expect(run(noGas.chain, "eth", "0.001")).rejects.toThrow(/0.001 ETH plus gas is needed/);
    expect(short.sent).toEqual([]);
    expect(noGas.sent).toEqual([]);
  });

  it("refuses a token the network mints on BrainChain only", async () => {
    const { chain } = fakeChain();
    await expect(run(chain, "eth", "0.001", true, TESTNET)).resolves.toBeDefined();
    (chain.tokenBalance as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("BrainChain testnet's stake token is not bridged from Robinhood Chain testnet"));
    await expect(run(chain, "stake", "1", false, TESTNET)).rejects.toThrow(/not bridged/);
  });
});
