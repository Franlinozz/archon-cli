# archon-scan

Archon audits for Mantle, from your terminal or CI. Zero dependencies, Node ≥ 18.

```bash
npx --yes github:Franlinozz/archon-cli scan contracts/Vault.sol --gas --fail-on high
```

- Submits the scan to Archon's public API and streams stage progress.
- Prints severity-ranked findings and the receipt-calibrated L2/DA gas split.
- Exits `2` when any finding is at/above `--fail-on` — gate merges in any CI.
- Read-only: never deploys, signs, or moves anything.

Canonical source: [`packages/cli` in Franlinozz/Archon](https://github.com/Franlinozz/Archon/tree/main/packages/cli) (the [archon-cli](https://github.com/Franlinozz/archon-cli) repo is an auto-generated npx mirror). Full documentation: <https://archonaudit.xyz/docs/platform-api/cli>.
