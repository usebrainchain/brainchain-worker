# Contributing

Bug reports and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

## Development

You need Node.js 22.12 or later.

```sh
npm ci
npm run build
npx tsc --noEmit -p tsconfig.test.json
npm test
node dist/index.js --help
```

CI runs the same steps on Node 22 and 24, and a smoke test on Windows (`node scripts/windows-smoke.mjs`).

Commands default to testnet. Testnet BRAIN and USDG come from faucets, so a change can be tried end to end without real funds; see the README's quick start. Use a wallet made for testing, never one that holds funds you care about.

The README is tested: `src/docs.test.ts` checks that it lists the same commands and settings as `--help`, and that its key figures match the code. Update the README and `--help` together.

## Pull requests

- One change per pull request, with what it does and why.
- A test for every change in behaviour.
- The README, `--help` and, where it applies, the OpenClaw skill in `examples/` updated with the behaviour.

Pull requests are squash-merged once CI passes. Releases are cut by the maintainers. By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
