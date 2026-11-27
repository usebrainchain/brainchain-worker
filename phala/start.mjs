#!/usr/bin/env node
// Runs a BrainChain worker inside a Phala Cloud CVM. The wallet key is derived by the enclave and handed to the worker
// on a pipe, so it is in no file, no environment and no log. On first start it asks the testnet gas drip for gas
// (testnet only) and joins once; then it runs, doing each task it is hired for with agent.mjs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DstackClientV0 } from "@phala/dstack-sdk";
import { privateKeyToAccount } from "viem/accounts";

import { joinArgs, KEY_PATH, keyFromSecret, settings } from "./lib.mjs";

const SOCKETS = ["/var/run/dstack.sock", "/run/dstack.sock"];
const RETRY_MS = 10 * 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const worker = join(dirname(createRequire(import.meta.url).resolve("brainchain-worker/package.json")), "dist/index.js");

const s = settings(process.env);

// Outside an enclave there is no key service. A key given in the environment is used then, for a local trial.
async function walletKey() {
  if (SOCKETS.some((path) => existsSync(path))) {
    const { key } = await new DstackClientV0().getKey(KEY_PATH, "wallet");
    return keyFromSecret(key);
  }
  if (process.env.BRAINCHAIN_WORKER_KEY) {
    console.log("No enclave here: using BRAINCHAIN_WORKER_KEY from the environment.");
    return process.env.BRAINCHAIN_WORKER_KEY;
  }
  throw new Error("No dstack socket: deploy this on Phala Cloud, or set BRAINCHAIN_WORKER_KEY for a local trial");
}

const key = await walletKey();
const address = privateKeyToAccount(key).address;
delete process.env.BRAINCHAIN_WORKER_KEY;
console.log(`BrainChain worker ${address} on ${s.network}, answering with ${s.model} through Phala's confidential AI`);

const state = join(homedir(), ".brainchain-worker-phala");
mkdirSync(state, { recursive: true, mode: 0o700 });
const marker = (name) => join(state, `${name}-${s.network}-${address.toLowerCase()}`);

// The worker reads the key from its stdin and keeps it out of the command it runs.
function run(args) {
  const child = spawn(process.execPath, [worker, ...args], {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, BRAINCHAIN_NETWORK: s.network, BRAINCHAIN_WORKER_KEY_FILE: "/dev/stdin" },
  });
  child.stdin.end(`${key}\n`);
  const forward = (signal) => child.kill(signal);
  process.on("SIGTERM", forward).on("SIGINT", forward);
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      process.off("SIGTERM", forward).off("SIGINT", forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

// The drip serves each address once, so it is asked once.
if (s.network === "testnet" && !existsSync(marker("drip"))) {
  const response = await fetch("https://brain.testnet.usebrainchain.com/testnet/gas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  }).catch((error) => ({ status: error.message, text: async () => "" }));
  console.log(`Testnet gas drip: ${response.status} ${(await response.text()).slice(0, 200)}`);
  writeFileSync(marker("drip"), new Date().toISOString());
}

// At most once per amount: running it again after a partial move could buy the stake twice.
if (s.fundUsdc && !existsSync(marker(`fund-${s.fundUsdc}`))) {
  writeFileSync(marker(`fund-${s.fundUsdc}`), new Date().toISOString());
  console.log(`Funding from the ${s.fundUsdc} USDC this address holds on Base: the BRAIN join needs, ETH for gas, bridged to BrainChain.`);
  const code = await run(["fund", "--from-base", "--usdc", s.fundUsdc, "--stake"]);
  if (code !== 0) console.log(`Funding from Base did not complete. It is not run again for ${s.fundUsdc} USDC: read the lines above, then set FUND_FROM_BASE_USDC to what is left on Base to run it once more.`);
}

// Joined once. A worker BrainChain refused is not sent in again by a restart: on mainnet that would forfeit another bond.
while (!existsSync(marker("joined"))) {
  const code = await run(joinArgs(s));
  if (code === 0) {
    writeFileSync(marker("joined"), new Date().toISOString());
    break;
  }
  console.log(`Join did not complete${s.network === "mainnet" ? `: ${address} needs the stake and gas on BrainChain, see Mainnet in the template's README` : ""}. It is tried again in ${RETRY_MS / 60_000} minutes.`);
  await sleep(RETRY_MS);
}

process.exitCode = await run(["run", "--exec", `node ${join(here, "agent.mjs")}`]);
