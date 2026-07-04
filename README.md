# archon-scan

Archon audits for Mantle, from your terminal or CI. Zero dependencies, Node ≥ 18.

```bash
# Scan a deployed, verified Mantle contract — works from any directory, no local files:
npx --yes github:Franlinozz/archon-cli scan 0xe7043e2ec95eF357FbBa3359BA2f1edb10cEAD2a --gas --fail-on high

# Or scan local Solidity from a repo checkout (a .sol file or a directory of them):
npx --yes github:Franlinozz/archon-cli scan contracts/VaultV2.sol --fail-on high
```

- Submits the scan to Archon's public API and streams stage progress.
- Prints severity-ranked findings and the receipt-calibrated L2/DA gas split.
- Exits `2` when any finding is at/above `--fail-on` — gate merges in any CI.
- Read-only: never deploys, signs, or moves anything.

Canonical source: [`packages/cli` in Franlinozz/Archon](https://github.com/Franlinozz/Archon/tree/main/packages/cli) (the [archon-cli](https://github.com/Franlinozz/archon-cli) repo is an auto-generated npx mirror). Full documentation: <https://archonaudit.xyz/docs/platform-api/cli>.
