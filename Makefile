# browser-bridge developer tasks — a `make` mirror of the justfile, so you can
# work without installing `just`. Keep the two in sync when adding a task.
# Requires: cargo, python3. Optional: bun + Chrome (browser tests), shellcheck.

NPM := npm --prefix extension

.DEFAULT_GOAL := help

.PHONY: help build fmt fmt-check lint lint-scripts test-rust test-e2e \
	ext-deps ext-build ext-typecheck ext-lint ext-format-check ext-test \
	test-browser test ci install sync-version check-version release

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

test: test-rust test-e2e ## All tests that run without a browser

ci: fmt-check lint lint-scripts test-rust ext-typecheck ext-lint ext-format-check ext-test ext-build test-e2e ## Everything CI runs

install: ## Install locally (build + copy binary + host manifest)
	./install.sh

sync-version: ## Propagate the Cargo.toml version into the extension files
	./scripts/sync-version.sh

check-version: ## Verify the crate and extension versions agree
	./scripts/check-version.sh

release: check-version ci ## Pre-release gate: versions consistent + full CI green
	@echo "Release checks passed. Now tag the release, e.g.: git tag v$$(./scripts/check-version.sh | awk '/Cargo.toml/{print $$2}')"
