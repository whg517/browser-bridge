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

# All tests that run without a browser
test: test-rust test-e2e

# Everything CI runs
ci: fmt-check lint test

# Install locally (build + copy binary + host manifest)
install:
    ./install.sh
