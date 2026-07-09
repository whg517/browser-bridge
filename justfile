# browser-bridge developer tasks.
# Requires: cargo, python3. Optional (DOM tests): bun + Chrome.
# Run `just` with no args to list recipes.

_default:
    @just --list

# Build the release binary
build:
    cargo build --release

# Format Rust sources
fmt:
    cargo fmt

# Verify formatting (CI gate)
fmt-check:
    cargo fmt --check

# Lint Rust, denying all warnings (CI gate)
lint:
    cargo clippy --all-targets -- -D warnings

# Rust unit tests
test-rust:
    cargo test

# Protocol-layer end-to-end tests (drives the real release binary)
test-e2e: build
    python3 tests/e2e.py

# ---- extension (TypeScript) ----------------------------------------------

# Install extension dev dependencies
ext-deps:
    npm --prefix extension install

# Build the extension bundle (src/ → dist/)
ext-build:
    npm --prefix extension run build

# Type-check the extension sources
ext-typecheck:
    npm --prefix extension run typecheck

# Lint the extension sources
ext-lint:
    npm --prefix extension run lint

# Verify extension formatting
ext-format-check:
    npm --prefix extension run format:check

# DOM-layer + smoke tests (needs bun + Chrome; builds the bundle first)
test-browser: ext-build
    cd tests && bun dom_test.ts
    node tests/ext_test.js

# ---- aggregates -----------------------------------------------------------

# All tests that run without a browser
test: test-rust test-e2e

# Everything CI runs (browser tests are separate — see test-browser)
ci: fmt-check lint test-rust ext-typecheck ext-lint ext-format-check ext-build test-e2e

# Install locally (build + copy binary + host manifest)
install:
    ./install.sh
