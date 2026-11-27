// What start.mjs and agent.mjs decide, kept apart from the processes they start so it can be tested.
import { createHash } from "node:crypto";

export const NETWORKS = ["testnet", "mainnet"];
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const DEFAULT_BASE = "https://inference.phala.com";
// Every one must pass: a skip means part of the answer went unchecked.
export const REQUIRED = ["receipt-1", "receipt-2", "receipt-3", "receipt-4", "upstream-1", "upstream-2"];
// The enclave derives the same secret for the same app on every boot, so the worker keeps its address and its record.
export const KEY_PATH = "brainchain-worker";

/** The deployment's settings, or an error that names what is missing. */
export function settings(env) {
  const network = env.BRAINCHAIN_NETWORK || "testnet";
  if (!NETWORKS.includes(network)) throw new Error(`BRAINCHAIN_NETWORK must be testnet or mainnet, not "${network}"`);
  const missing = ["PHALA_AI_API_KEY", "WORKER_NAME", "WORKER_ABOUT"].filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")} in the deployment's environment`);
  const price = amount(env, "WORKER_PRICE", "a USDG amount such as 0.30");
  const fundUsdc = amount(env, "FUND_FROM_BASE_USDC", "a USDC amount such as 120");
  if (fundUsdc !== undefined && network !== "mainnet") throw new Error("FUND_FROM_BASE_USDC is for mainnet; testnet joins from its faucet");
  return { network, name: env.WORKER_NAME.trim(), about: env.WORKER_ABOUT.trim(), price, fundUsdc, model: env.MODEL?.trim() || DEFAULT_MODEL };
}

function amount(env, name, what) {
  const value = env[name]?.trim() || undefined;
  if (value !== undefined && !/^\d+(\.\d{1,6})?$/.test(value)) throw new Error(`${name} is ${what}, not "${value}"`);
  return value;
}

/** The worker's private key from the secret the enclave derives, hashed as dstack's own viem adapter does. */
export const keyFromSecret = (secret) => `0x${createHash("sha256").update(secret).digest("hex")}`;

export function joinArgs({ name, about, price }) {
  return ["join", "--name", name, "--about", about, ...(price ? ["--price", price] : [])];
}

/** Which required checks of an enclave receipt did not pass. */
export const unmet = (lines) => REQUIRED.filter((id) => !lines.some((line) => line.id === id && line.status === "pass"));

/** The answer's text from a chat completion, or undefined when there is none to deliver. */
export function answerOf(body) {
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content : undefined;
}
