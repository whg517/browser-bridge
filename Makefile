# browser-bridge developer tasks. `make help` lists them.
# Requires: cargo, python3. Optional: bun + Chrome (browser tests), shellcheck.
# Every recipe is a plain command you can also run by hand (see docs/development.md).

NPM := npm --prefix extension

.DEFAULT_GOAL := help

.PHONY: help build fmt fmt-check lint lint-scripts test-rust test-e2e \
	ext-deps ext-build ext-typecheck ext-lint ext-format-check ext-test \
	test-browser test-integration test ci install sync-version check-extension-id check-version release

help: ## List available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*## "}{printf "  %-18s %s\n", $$1, $$2}'

build: ## Build the release binary
	cargo build --release

fmt: ## Format Rust sources
	cargo fmt

fmt-check: ## Verify Rust formatting (CI gate)
	cargo fmt --check

lint: ## Lint Rust, denying all warnings (CI gate)
	cargo clippy --all-targets -- -D warnings

lint-scripts: ## Lint shell scripts (needs shellcheck)
	shellcheck install.sh scripts/*.sh tests/run_all.sh

audit: ## Supply-chain checks (needs cargo-deny, cargo-audit)
	cargo deny check
	cargo audit

gen: ## Regenerate code from contracts/ (ops.ts from tools.json)
	node scripts/gen-ops.mjs
	npm --prefix extension exec prettier -- --write extension/src/shared/ops.ts

test-rust: ## Rust unit tests
	cargo test

test-e2e: build ## Protocol-layer e2e tests (drives the real release binary)
	python3 tests/e2e.py

ext-deps: ## Install extension dev dependencies
	$(NPM) install

ext-build: ## Build the extension bundle (src/ -> dist/)
	$(NPM) run build

ext-typecheck: ## Type-check the extension sources
	$(NPM) run typecheck

ext-lint: ## Lint the extension sources
	$(NPM) run lint

ext-format-check: ## Verify extension formatting
	$(NPM) run format:check

ext-test: ## Unit-test the extension's shared modules (bun; no browser)
	$(NPM) test

test-browser: ext-build ## DOM + smoke tests (needs bun + Chrome; builds first)
	cd tests && bun dom_test.ts
	bun tests/ext_test.ts

test-integration: build ext-build ## Real E2E integration (opt-in; real binary + Chrome + extension)
	BB_REAL_E2E=1 bun tests/integration_e2e.ts

test: test-rust test-e2e ## All tests that run without a browser

ci: fmt-check lint lint-scripts test-rust ext-typecheck ext-lint ext-format-check ext-test ext-build test-e2e ## Everything CI runs

install: ## Install locally (build + copy binary + host manifest)
	./install.sh

sync-version: ## Propagate the Cargo.toml version into the extension files
	./scripts/sync-version.sh

check-version: ## Verify the crate and extension versions agree
	./scripts/check-version.sh

check-extension-id: ## Verify the manifest key and installer extension IDs agree
	node scripts/check-extension-id.mjs

release: check-version check-extension-id ci ## Pre-release gate: versions consistent + full CI green
	@echo "Release checks passed. Now tag the release, e.g.: git tag v$$(./scripts/check-version.sh | awk '/Cargo.toml/{print $$2}')"
