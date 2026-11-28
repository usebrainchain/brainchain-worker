#!/usr/bin/env node
// Runs a BrainChain worker inside a Phala Cloud CVM. The wallet key is derived by the enclave and handed to the worker
// through a named pipe, so it is in no file, no environment and no log. On testnet it asks the gas drip for gas until
// it has had some; on mainnet it funds itself from Base. It joins once, then runs, doing each task it is hired for
// with agent.mjs.
import { execFileSync, spawn } from "node:child_process";
import { constants, existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DstackClientV0 } from "@phala/dstack-sdk";
import { privateKeyToAccount } from "viem/accounts";

import { handOver, joinArgs, KEY_PATH, keyFromSecret, refusedIn, settings } from "./lib.mjs";

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

// The worker reads the key from a named pipe and keeps it out of the command it runs. Node gives a child a socket, not
// a pipe, for its stdin, and a socket cannot be opened by path, so the key goes through a FIFO only the worker reads.
let pipes = 0;
/** Runs brainchain-worker with the key; resolves to its exit code and, with `capture`, what it printed. */
function run(args, { capture = false } = {}) {
  const fifo = join(existsSync("/dev/shm") ? "/dev/shm" : state, `key-${process.pid}-${(pipes += 1)}`);
  execFileSync("mkfifo", ["-m", "600", fifo]);
  const child = spawn(process.execPath, [worker, ...args], {
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    env: { ...process.env, BRAINCHAIN_NETWORK: s.network, BRAINCHAIN_WORKER_KEY_FILE: fifo },
  });
  let out = "";
  child.stdout?.on("data", (chunk) => {
    out += chunk;
    process.stdout.write(chunk);
  });
  // A stop forwarded to the worker is a clean end, not a failure for the container's restart policy.
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1))));
  // Opening the write end waits for the worker to open the read end. A worker that exits first never will, so on its
  // exit the read end is opened here, which lets the write go into a pipe nobody reads. The FIFO stays until then: a
  // worker that finds a pipe at its key path knows the key is in no file, and one that does not restarts itself through
  // a file in /dev/shm to clear its environment.
  handOver(fifo, key);
  exited.then(() => {
    try {
      closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
    } catch {
      // Nothing to unblock.
    }
    try {
      unlinkSync(fifo);
    } catch {
      // Already gone.
    }
  });
  const forward = (signal) => child.kill(signal);
  process.on("SIGTERM", forward).on("SIGINT", forward);
  return exited.then((code) => ({ code, out })).finally(() => process.off("SIGTERM", forward).off("SIGINT", forward));
}

// The drip serves each address once: a 200 sent it, a 409 says it was sent before or the address holds enough. Anything
// else, such as a paused drip, is asked again before the next try at joining.
async function drip() {
  if (s.network !== "testnet" || existsSync(marker("drip"))) return;
  const response = await fetch("https://brain.testnet.usebrainchain.com/testnet/gas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  }).catch((error) => ({ status: 0, text: async () => error.message }));
  console.log(`Testnet gas drip: ${response.status} ${(await response.text()).slice(0, 200)}`);
  if (response.status === 200 || response.status === 409) writeFileSync(marker("drip"), new Date().toISOString());
}

// The dry run reads the balance and fees and prices both legs, sending nothing, so USDC that has not arrived or a quote
// refused is checked again on the next try. Once a real run starts it is at most once per amount: running it again
// after a partial move could buy the stake twice.
async function fund() {
  if (!s.fundUsdc || existsSync(marker(`fund-${s.fundUsdc}`))) return;
  const args = ["fund", "--from-base", "--usdc", s.fundUsdc, "--stake"];
  console.log(`Funding from the ${s.fundUsdc} USDC this address holds on Base: the BRAIN join needs, ETH for gas, bridged to BrainChain.`);
  if ((await run([...args, "--dry"])).code !== 0) return console.log("Funding was checked and nothing was sent. It is checked again before the next try at joining.");
  writeFileSync(marker(`fund-${s.fundUsdc}`), new Date().toISOString());
  const { code } = await run(args);
  if (code !== 0) console.log(`Funding from Base did not complete. It is not run again for ${s.fundUsdc} USDC: read the lines above, then set FUND_FROM_BASE_USDC to what is left on Base to run it once more.`);
}

// Joined once. A worker BrainChain refused is not sent in again: on mainnet that would forfeit another bond. A join can
// fail after its application went out, so before each try the worker's status is read for a refusal.
while (!existsSync(marker("joined"))) {
  await fund();
  await drip();
  const standing = await run(["status"], { capture: true });
  if (standing.code === 0 && refusedIn(standing.out)) {
    console.log("BrainChain refused this worker, so it does not apply again by itself. Read the logs and decide.");
    break;
  }
  const { code } = standing.code === 0 ? await run(joinArgs(s)) : { code: standing.code };
  if (code === 0) {
    writeFileSync(marker("joined"), new Date().toISOString());
    break;
  }
  console.log(`Join did not complete${s.network === "mainnet" ? `: ${address} needs the stake and gas on BrainChain, see Mainnet in the template's README` : ""}. It is tried again in ${RETRY_MS / 60_000} minutes.`);
  await sleep(RETRY_MS);
}

process.exitCode = (await run(["run", "--exec", `node ${join(here, "agent.mjs")}`])).code;
