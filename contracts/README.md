# contracts/

The **single source of truth** for cross-process contracts. Edit here, then
regenerate/verify — don't hand-edit the derived files.

## `tools.json`

The tool catalogue: for each tool, its `name`, `uiLabel` (options page), `risk`,
`scope`, `permission`, `confirmation`, model-facing `description`, and
`inputSchema`.

Derived / verified from it:

- **`extension/src/shared/ops.ts`** — *generated* by `scripts/gen-ops.mjs`
  (`make gen`). CI fails if it's out of date.
- **`src/tools.rs`** — *verified* by the `matches_contract` test (`cargo test`):
  names, descriptions, and schemas must match the contract.
- **`extension/src/shared/ops.test.ts`** — asserts `ops.ts` matches the contract.

So a tool's identity lives in one place; Rust and TypeScript both fail CI if
they drift from it.

## Adding / changing a tool

1. Edit `tools.json`.
2. `make gen` (regenerates `ops.ts`).
3. Update the Rust handler in `src/tools.rs` (the test enforces parity).
4. `cargo test` + `make ci`.

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-tool).
