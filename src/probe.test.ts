import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { PROBE_CODE } from "./probe.js";

// solc-js ships no types; these are the two calls made of it.
const solc = createRequire(import.meta.url)("solc") as { version(): string; compile(input: string): string };

/** Runtime code without the CBOR metadata solc appends, whose hash changes with the source's path and comments. */
function withoutMetadata(code: string): string {
  const hex = code.replace(/^0x/, "");
  const length = parseInt(hex.slice(-4), 16);
  return hex.slice(0, hex.length - (length + 2) * 2);
}

describe("PROBE_CODE", () => {
  it("is scripts/probe.sol built with solc 0.8.28, the optimizer on and the cancun EVM, as its header says", () => {
    expect(solc.version()).toMatch(/^0\.8\.28\+/);
    const source = readFileSync(new URL("../scripts/probe.sol", import.meta.url), "utf8");
    const input = {
      language: "Solidity",
      sources: { "probe.sol": { content: source } },
      settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { SwapProbe: ["evm.deployedBytecode.object"] } } },
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
      errors?: { severity: string; formattedMessage: string }[];
      contracts: Record<string, Record<string, { evm: { deployedBytecode: { object: string } } }>>;
    };
    expect((output.errors ?? []).filter((e) => e.severity === "error").map((e) => e.formattedMessage)).toEqual([]);
    const built = output.contracts["probe.sol"]!.SwapProbe!.evm.deployedBytecode.object;
    expect(withoutMetadata(PROBE_CODE)).toBe(withoutMetadata(built));
  });
});
