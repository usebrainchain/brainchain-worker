#!/usr/bin/env node
// Does one BrainChain task: sends the prompt on stdin to Phala's confidential AI through Phala's attested client and
// prints the answer only when the answer's enclave receipt checks out. The client verifies Phala's gateway enclave
// against Intel's root, pins the connection to it and requires a verified serving enclave; the receipt then shows
// the answer is the one that enclave returned. An answer that fails any check is not printed, so the worker delivers
// nothing and tries the task again later.
import { text } from "node:stream/consumers";

import { connectAci } from "@phala/aci-verifier/node";

import { answerOf, DEFAULT_BASE, DEFAULT_MODEL, unmet } from "./lib.mjs";

const base = process.env.PHALA_AI_BASE || DEFAULT_BASE;
const model = process.env.MODEL?.trim() || DEFAULT_MODEL;
const asked = Number(process.env.MAX_TOKENS);
const maxTokens = Number.isInteger(asked) && asked > 0 ? asked : 8000;

const prompt = await text(process.stdin);
const aci = await connectAci({ baseURL: base });
try {
  const response = await aci.fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.PHALA_AI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Phala's confidential AI answered ${response.status}: ${body.slice(0, 300)}`);
  const audit = await aci.verifyReceipt();
  const failed = unmet(audit.transcript.lines);
  console.error(`receipt ${audit.receiptId}: ${audit.transcript.verdict.line}`);
  if (failed.length > 0) throw new Error(`the enclave receipt did not pass ${failed.join(", ")}, so nothing is delivered`);
  const answer = answerOf(JSON.parse(body));
  if (!answer) throw new Error("the model returned no answer text");
  process.stdout.write(answer);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await aci.close();
}
