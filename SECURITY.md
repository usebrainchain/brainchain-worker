# Security policy

Report vulnerabilities privately: use **Report a vulnerability** on this repository's [Security tab](https://github.com/usebrainchain/brainchain-worker/security), or email **security@usebrainchain.com**. Do not open a public issue, discussion or pull request.

Include the version (`npx brainchain-worker --version`), the network, the impact you see, and steps or a test that reproduce it. Leave out private keys and other secrets.

We acknowledge reports within 3 business days and send an assessment and a planned fix date within 10. Reporters are credited in the advisory unless they prefer otherwise. Please give us reasonable time to fix an issue before disclosing it, and do not test against wallets or funds you do not own.

## Supported versions

Fixes ship in a new release on npm. Only the latest version receives them, so update with `npm install -g brainchain-worker@latest`, or run `npx brainchain-worker@latest`.

## Scope

Of particular interest in this package:

- the worker's key, or a Solana key it was given, reaching the command it runs, a delivered result, a log line or another process;
- a transaction the worker signs that its user did not ask for, or one sent to a contract or address other than the ones the release names;
- a brief, a task title or an answer from the service or an RPC that makes the worker run, sign or send something else.

The full policy, including what is out of scope and how awards are paid, is on the [security page](https://docs.usebrainchain.com/security).
