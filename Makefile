# browser-bridge developer tasks. `make help` lists them.
# Requires: cargo, python3. Optional: bun + Chrome (browser tests), shellcheck.
# Every recipe is a plain command you can also run by hand (see docs/development.md).

NPM := npm --prefix extension
EXT_NM := extension/node_modules

.DEFAULT_GOAL := help

.PHONY: help build fmt fmt-check lint lint-scripts audit gen gen-check \
	test-rust test-e2e ext-deps ext-build ext-typecheck ext-lint \
	ext-format-check ext-test ext-package test-browser test-integration test ci \
	install stamp-version check-extension-id check-version release changelog test-scripts

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
	shellcheck install/install.sh scripts/*.sh tests/run_all.sh

audit: ## Supply-chain checks (needs cargo-deny, cargo-audit)
	cargo deny check
	cargo audit

gen: $(EXT_NM) ## Regenerate code from contracts/ (ops.ts from tools.json)
	node scripts/gen-ops.mjs
	$(NPM) exec prettier -- --write extension/src/shared/ops.ts

gen-check: gen ## Regenerate and fail if ops.ts drifted from contracts/ (CI gate)
	@git diff --exit-code -- extension/src/shared/ops.ts \
		|| { echo "ops.ts is stale — commit the result of 'make gen'"; exit 1; }

test-rust: ## Rust unit tests
	cargo test

test-e2e: build ## Protocol-layer e2e tests (drives the real release binary)
	python3 tests/e2e.py

ext-deps: ## Install/update extension dev dependencies (npm install)
	$(NPM) install

# Sentinel: install from the lockfile, and only when it changes. Extension
# targets depend on this so they work from a clean checkout with no manual
# ext-deps, without reinstalling on every run.
$(EXT_NM): extension/package-lock.json
	$(NPM) ci
	@touch $@

ext-build: $(EXT_NM) ## Build the extension bundle (src/ -> dist/)
	$(NPM) run build

ext-typecheck: $(EXT_NM) ## Type-check the extension sources
	$(NPM) run typecheck

ext-lint: $(EXT_NM) ## Lint the extension sources
	$(NPM) run lint

ext-format-check: $(EXT_NM) ## Verify extension formatting
	$(NPM) run format:check

ext-test: $(EXT_NM) ## Unit-test the extension's shared modules (bun; no browser)
	$(NPM) test

ext-package: ext-build ## Zip the built extension: load-unpacked + store zips (-> dist-artifacts/)
	@mkdir -p dist-artifacts
	@rm -f dist-artifacts/browser-bridge-extension.zip dist-artifacts/browser-bridge-extension-store.zip
	(cd extension/dist && zip -qrX "$(CURDIR)/dist-artifacts/browser-bridge-extension.zip" . -x ".*")
	@rm -rf dist-artifacts/store-pkg && cp -r extension/dist dist-artifacts/store-pkg
	node -e 'const fs=require("fs");const f="dist-artifacts/store-pkg/manifest.json";const m=JSON.parse(fs.readFileSync(f,"utf8"));delete m.key;fs.writeFileSync(f,JSON.stringify(m,null,2));'
	(cd dist-artifacts/store-pkg && zip -qrX "$(CURDIR)/dist-artifacts/browser-bridge-extension-store.zip" . -x ".*")
	@rm -rf dist-artifacts/store-pkg
	@echo "packaged in dist-artifacts/:  browser-bridge-extension.zip (key KEPT — Load unpacked)  +  browser-bridge-extension-store.zip (key STRIPPED — Chrome Web Store)"
	@# A local package is built off the 0.0.0 placeholder, so the store zip is
	@# unpublishable (the CWS rejects 0.0.0 / duplicate versions). Warn rather than
	@# fail: packaging for Load-unpacked is a legitimate everyday dev action, and
	@# release.yml stamps the real version before it builds its own zips.
	@./scripts/check-version.sh >/dev/null 2>&1 && { \
		echo ""; \
		echo "WARNING: this tree is at the 0.0.0 placeholder, so the store zip is NOT"; \
		echo "         uploadable. Publish the -store.zip from a tagged release instead"; \
		echo "         (docs/chrome-web-store.md)."; \
	} || true

test-browser: ext-build ## DOM + smoke tests (needs bun + Chrome; builds first)
	cd tests && bun dom_test.ts
	bun tests/ext_test.ts

test-integration: build ext-build ## Real E2E integration (opt-in; real binary + Chrome + extension)
	BB_REAL_E2E=1 bun tests/integration_e2e.ts

test: test-rust ext-test test-e2e ## All tests that run without a browser

ci: fmt-check lint lint-scripts test-scripts test-rust gen-check ext-typecheck ext-lint ext-format-check ext-test ext-build check-version check-extension-id test-e2e ## Local CI gates (all jobs except the browser + installer-smoke ones)

install: ## Install locally (build + copy binary + host manifest)
	./install/install.sh

stamp-version: ## Stamp VERSION=x.y.z across crate+extension (no VERSION resets to 0.0.0)
	./scripts/stamp-version.sh $(VERSION)

check-version: ## Verify the tree holds the 0.0.0 placeholder consistently
	./scripts/check-version.sh

changelog: ## Generate the CHANGELOG section for VERSION from commits since the last tag
	@test -n "$(VERSION)" || { echo "usage: make changelog VERSION=x.y.z"; exit 2; }
	node scripts/changelog-gen.mjs $(VERSION) --write
	@echo "Review and edit CHANGELOG.md, then commit it before tagging."

test-scripts: ## Unit-test the scripts/ helpers (node's built-in runner)
	node --test "scripts/*.test.mjs"

check-extension-id: ## Verify the manifest key and installer extension IDs agree
	node scripts/check-extension-id.mjs

release: ci ## Pre-release gate: full local CI green (versions + IDs included)
	@echo "Release checks passed. The version is stamped from the tag by the release"
	@echo "workflow (ADR-0026) — this tree stays at the 0.0.0 placeholder. Add the"
	@echo "CHANGELOG section for the version you are releasing, then tag it:"
	@echo "    git tag vX.Y.Z && git push --tags"
