import assert from "node:assert/strict";
import test from "node:test";

import { answerOf, DEFAULT_MODEL, joinArgs, keyFromSecret, refusedIn, settings, unmet } from "./lib.mjs";

const base = { PHALA_AI_API_KEY: "k", WORKER_NAME: " Atlas ", WORKER_ABOUT: "Summaries and code review" };

test("settings: testnet and the default model unless told otherwise, names what is missing", () => {
  assert.deepEqual(settings(base), { network: "testnet", name: "Atlas", about: "Summaries and code review", price: undefined, fundUsdc: undefined, model: DEFAULT_MODEL });
  assert.equal(settings({ ...base, BRAINCHAIN_NETWORK: "mainnet", MODEL: "phala/qwen3.8-27b-uncensored", WORKER_PRICE: "0.30" }).price, "0.30");
  assert.throws(() => settings({ ...base, BRAINCHAIN_NETWORK: "devnet" }), /testnet or mainnet/);
  assert.throws(() => settings({ WORKER_NAME: "A" }), /Set PHALA_AI_API_KEY, WORKER_ABOUT/);
  assert.throws(() => settings({ ...base, WORKER_PRICE: "cheap" }), /USDG amount/);
  assert.equal(settings({ ...base, BRAINCHAIN_NETWORK: "mainnet", FUND_FROM_BASE_USDC: "120" }).fundUsdc, "120");
  assert.throws(() => settings({ ...base, FUND_FROM_BASE_USDC: "120" }), /for mainnet/);
  assert.throws(() => settings({ ...base, BRAINCHAIN_NETWORK: "mainnet", FUND_FROM_BASE_USDC: "all" }), /USDC amount/);
});

test("settings stop at boot what join or fund would refuse on every retry", () => {
  assert.equal(settings({ ...base, WORKER_NAME: "n".repeat(60) }).name, "n".repeat(60));
  assert.throws(() => settings({ ...base, WORKER_NAME: "n".repeat(61) }), /at most 60/);
  assert.throws(() => settings({ ...base, WORKER_NAME: "Atlas\u202eevil" }), /invisible or direction-changing/);
  assert.throws(() => settings({ ...base, WORKER_NAME: "Two\nlines" }), /one line/);
  assert.equal(settings({ ...base, WORKER_ABOUT: "Line one\nLine two" }).about, "Line one\nLine two");
  assert.throws(() => settings({ ...base, WORKER_ABOUT: "a".repeat(501) }), /at most 500/);
  assert.throws(() => settings({ ...base, WORKER_ABOUT: "hidden\u200bspace" }), /invisible or direction-changing/);
  assert.throws(() => settings({ ...base, WORKER_PRICE: "1000000" }), /0 to 999999/);
  assert.throws(() => settings({ ...base, BRAINCHAIN_NETWORK: "mainnet", FUND_FROM_BASE_USDC: "2" }), /more than the 2 USDC/);
  assert.equal(settings({ ...base, BRAINCHAIN_NETWORK: "mainnet", FUND_FROM_BASE_USDC: "2.5" }).fundUsdc, "2.5");
  assert.equal(settings({ ...base, MODEL: "  " }).model, DEFAULT_MODEL);
});

test("a refusal in the worker's status is recognised, and nothing else is", () => {
  assert.equal(refusedIn("  Hireable  no: BrainChain did not allow application 77, and its bond was burned. Run brainchain-worker join to apply again."), true);
  assert.equal(refusedIn("  Hireable  no: application 77 has waited for BrainChain's decision since 2026-11-27T22:29:06Z."), false);
  assert.equal(refusedIn("  Hireable  no: BrainChain allowed this worker; it can be hired after 2026-11-28T00:29:34Z"), false);
});

test("join arguments carry the price only when one is set", () => {
  assert.deepEqual(joinArgs({ name: "A", about: "B" }), ["join", "--name=A", "--about=B"]);
  assert.deepEqual(joinArgs({ name: "--A", about: "B", price: "0.3" }), ["join", "--name=--A", "--about=B", "--price=0.3"]);
});

test("the wallet key is the SHA-256 of the enclave's secret, the same secret giving the same key", () => {
  const key = keyFromSecret(new Uint8Array([1, 2, 3]));
  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.equal(key, keyFromSecret(new Uint8Array([1, 2, 3])));
  assert.notEqual(key, keyFromSecret(new Uint8Array([1, 2, 4])));
  // Pinned: a change here would move every deployed worker to a new address.
  assert.equal(key, "0x039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
});

test("every receipt and upstream check must pass; a skip counts as not passed", () => {
  const pass = (id) => ({ id, status: "pass" });
  const all = ["receipt-1", "receipt-2", "receipt-3", "receipt-4", "upstream-1", "upstream-2"].map(pass);
  assert.deepEqual(unmet(all), []);
  assert.deepEqual(unmet(all.map((l) => (l.id === "receipt-4" ? { ...l, status: "skip" } : l))), ["receipt-4"]);
  assert.deepEqual(unmet([]), ["receipt-1", "receipt-2", "receipt-3", "receipt-4", "upstream-1", "upstream-2"]);
});

test("an answer is the first choice's text, and blank text is no answer", () => {
  assert.equal(answerOf({ choices: [{ message: { content: "done" } }] }), "done");
  assert.equal(answerOf({ choices: [{ message: { content: "  " } }] }), undefined);
  assert.equal(answerOf({}), undefined);
});
