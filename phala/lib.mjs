// What start.mjs and agent.mjs decide, kept apart from the processes they start so it can be tested.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const NETWORKS = ["testnet", "mainnet"];
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const DEFAULT_BASE = "https://inference.phala.com";
// Every one must pass: a skip means part of the answer went unchecked.
export const REQUIRED = ["receipt-1", "receipt-2", "receipt-3", "receipt-4", "upstream-1", "upstream-2"];
// The enclave derives the same secret for the same app on every boot, so the worker keeps its address and its record.
export const KEY_PATH = "brainchain-worker";
// brainchain-worker's own limits for join and fund, checked here so a bad setting stops the boot instead of failing
// every retry. UNSEEN is its pattern for invisible and direction-changing characters.
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}͏ᅟᅠ឴឵᠋-᠏⁥⠀ㅤ︀-️ﾠ￰-￸\u{e0000}-\u{e0fff}]/u;
const PRICE = /^\d{1,6}(\.\d{1,6})?$/;
// fund --stake keeps 2 USDC for gas and needs more than that.
const GAS_USDC = 2;

/** The deployment's settings, or an error that names what is missing. */
export function settings(env) {
  const network = env.BRAINCHAIN_NETWORK || "testnet";
  if (!NETWORKS.includes(network)) throw new Error(`BRAINCHAIN_NETWORK must be testnet or mainnet, not "${network}"`);
  const missing = ["PHALA_AI_API_KEY", "WORKER_NAME", "WORKER_ABOUT"].filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")} in the deployment's environment`);
  const name = env.WORKER_NAME.trim();
  const about = env.WORKER_ABOUT.trim();
  // Counted as brainchain-worker counts them, in UTF-16 units.
  if (name.length > 60) throw new Error("WORKER_NAME is at most 60 characters");
  if (UNSEEN.test(name)) throw new Error("WORKER_NAME must be one line with no invisible or direction-changing characters");
  if (about.length > 500) throw new Error("WORKER_ABOUT is at most 500 characters");
  if (UNSEEN.test(about.replace(/[\t\n]/g, " "))) throw new Error("WORKER_ABOUT must have no invisible or direction-changing characters");
  const price = amount(env, "WORKER_PRICE", "a USDG amount from 0 to 999999 such as 0.30");
  if (price !== undefined && !PRICE.test(price)) throw new Error(`WORKER_PRICE is a USDG amount from 0 to 999999 such as 0.30, not "${price}"`);
  const fundUsdc = amount(env, "FUND_FROM_BASE_USDC", "a USDC amount such as 120");
  if (fundUsdc !== undefined && network !== "mainnet") throw new Error("FUND_FROM_BASE_USDC is for mainnet; testnet joins from its faucet");
  if (fundUsdc !== undefined && Number(fundUsdc) <= GAS_USDC) throw new Error(`FUND_FROM_BASE_USDC must be more than the ${GAS_USDC} USDC kept for gas`);
  return { network, name, about, price, fundUsdc, model: env.MODEL?.trim() || DEFAULT_MODEL };
}

function amount(env, name, what) {
  const value = env[name]?.trim() || undefined;
  if (value !== undefined && !/^\d+(\.\d{1,6})?$/.test(value)) throw new Error(`${name} is ${what}, not "${value}"`);
  return value;
}

/** The worker's private key: the SHA-256 of the secret the enclave derives. Changing it moves every deployed worker's address. */
export const keyFromSecret = (secret) => `0x${createHash("sha256").update(secret).digest("hex")}`;

export function joinArgs({ name, about, price }) {
  // Inline values, so a name or description that starts with -- is read as text, not as a flag.
  return ["join", `--name=${name}`, `--about=${about}`, ...(price ? [`--price=${price}`] : [])];
}

/**
 * Writes the key into the worker's FIFO; true when it was handed over. The open has no O_CREAT: once the worker has
 * exited and the FIFO is removed, it fails instead of making a regular file with the key in it. It blocks, as any
 * FIFO open for writing does, until the worker opens the read end.
 */
export async function handOver(fifo, key) {
  const fd = await open(fifo, constants.O_WRONLY).catch(() => undefined);
  if (!fd) return false;
  try {
    if (!(await fd.stat()).isFIFO()) return false;
    await fd.writeFile(`${key}\n`);
    return true;
  } catch {
    return false;
  } finally {
    await fd.close();
  }
}

/** Whether brainchain-worker's status says BrainChain refused an application, which burned its bond. */
export const refusedIn = (status) => /did not allow application \d+, and its bond was burned/.test(status);

/** Which required checks of an enclave receipt did not pass. */
export const unmet = (lines) => REQUIRED.filter((id) => !lines.some((line) => line.id === id && line.status === "pass"));

/** The answer's text from a chat completion, or undefined when there is none to deliver. */
export function answerOf(body) {
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content : undefined;
}
