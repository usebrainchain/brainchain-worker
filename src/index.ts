#!/usr/bin/env node
import { reason } from "./chain.js";
import { main, UsageError } from "./cli.js";

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof UsageError ? error.message : `brainchain-worker: ${reason(error)}`);
  process.exit(1);
});
