# ADR-0012: Write the extension in TypeScript, bundle to dist/ with esbuild

- **Status**: Accepted
- **Date**: 2026-07-10
- **Deciders**: User + AI assistant

## Background

The v0.1/v0.2 MV3 extension was four hand-written native `.js` files (`background.js` / `content.js` / `options.js` / `popup.js`), loaded directly via load-unpacked from the `extension/` directory. This was fast enough during the prototype phase, but as ADR-0008 (page_eval), ADR-0009 (page_snapshot_precise), ADR-0010 (cookie/storage), and ADR-0011 (Options page) landed one after another, the amount and complexity of extension-side code grew, and several problems began to surface:

- **No types**: the `chrome.*` API and the `op`/`args`/response structure of bridge messages all relied on memory and comment conventions. When refactoring or adding tools, it was easy to miss a field or pass the wrong type, and such mistakes could only be caught by runtime errors.
- **No static checking**: unused variables, misspelled branches, and implicit `any` went unblocked.
- **Cross-file synchronization was entirely manual**: `op` strings and the `DEFAULTS` constant were mirrored across background/content/options in multiple places (see ADR-0011), with no compile-time guarantee whatsoever.
- **Maintainability**: files kept growing larger; without modularization and type constraints, the barrier to entry for new contributors was high.

The engineering-standardization cleanup needed to give the extension types, lint, and a reproducible build pipeline. Introducing types means the source is no longer `.js` that a browser can consume directly — there must be a build step that strips the types and turns the source into an artifact the extension can load.

## Decision

**Rewrite the extension source in TypeScript (`extension/src/*.ts`, strict mode), bundle it into IIFEs with esbuild to `extension/dist/`, and make dist/ the new load-unpacked target.**

- The four entry points `src/{background,content,options,popup}.ts` are each bundled into `dist/*.js`.
- Static assets (`manifest.json`, `popup.html`, `options.html`, `toast.css`, `icons/`) are copied verbatim into dist/ by the build script (`build.mjs`).
- Output is **IIFE format, unminified (`minify: false`)**, so the unpacked extension stays readable and debuggable; `target: chrome116`.
- Type checking (`tsc --noEmit`), lint (ESLint), and formatting (Prettier) are decoupled from bundling — esbuild only strips types and bundles, it does no type validation (see the CI gates in ADR-0013).

## Alternatives Considered

### Option A: keep hand-writing native JS (current state)
- **Pros**: zero build, zero dependencies; reload directly after editing.
- **Cons**: no types, no static checking, cross-file synchronization relies entirely on comments; the extension's complexity has reached the tipping point where types are needed as a safety net.
- **Not chosen**: the core goal of the cleanup is precisely to add types and checks.

### Option B: compile directly with tsc (no bundler)
- **Pros**: official toolchain, zero extra bundler dependency.
- **Cons**: `tsc` only does per-file transpilation, no bundling; if shared modules are split out later (e.g. a unified `DEFAULTS`/type definitions), ESM/import is loaded differently across MV3 contexts (SW, content script, and page script rules all differ), so tsc output is hard to run directly; and you still have to write your own asset-copy script.
- **Not chosen**: you'd either give up modularization or bolt on extra bundling logic — better to just use a bundler.

### Option C: webpack
- **Pros**: mature ecosystem, rich MV3 plugins.
- **Cons**: heavy configuration (a whole set of loader/plugin/mode), a large dependency tree, slow cold start; for a scale of "four entry points + copying a few static files" it's using a sledgehammer to crack a nut.
- **Excluded**: conflicts with the project's consistent orientation toward "minimal dependencies, auditable artifacts."

### Option D: rollup
- **Pros**: clean output, good tree-shaking.
- **Cons**: TS support requires attaching plugins (`@rollup/plugin-typescript`, etc.), with scattered configuration; slower than esbuild.
- **Not chosen**: esbuild covers TS + bundle with a single dependency, which is more economical.

### Option E: esbuild (adopted)
- **Pros**: **a single fast dependency** covers "strip TS types + bundle"; the configuration is just one `build.mjs`, with no config sprawl; `format: "iife"` directly produces self-contained scripts that each context can load; `--watch` makes development iteration fast.
- **Cons**: esbuild itself does no type checking (which is exactly why `tsc --noEmit` is split out into a separate gate); tree-shaking/optimization is not as extreme as rollup's, but this project doesn't minify and doesn't chase minimal size, so it doesn't matter.
- **Adopted.**

## Behavioral-neutrality verification of the migration

The rework proceeds in two stages — first build the pipeline, then add types (see Phase 2a/2b/2c in the git history) — and the key is to prove that "introducing a build step" by itself does not change runtime behavior:

- **Phase 2a** only builds the pipeline: `background.js → src/background.ts` and the others are moved over verbatim with git rename (preserving history), **with no type annotations added at all**. At this point all esbuild does to these "pure JS files that merely changed suffix" is "strip zero types + wrap in an IIFE," and the resulting `dist/*.js` is semantically equivalent to the original files — it can be regarded as a near-byte-identical transfer, which isolates the two variables of "build pipeline" and "type rework."
- The existing test suite locks the behavior: `dom_test` 77/77 (unchanged), smoke 4/4, protocol e2e 45/45, all green, proving the build step is behavior-neutral.
- **Phase 2b/2c** only then add strict types file by file on top of the verified pipeline, add ESLint/Prettier, and remove dead code.

`tests/dom_test.ts` reads the **build artifact** `extension/dist/content.js` directly (rather than the source `.ts`) to run DOM-layer assertions — it tests the exact code the browser actually loads, and incidentally brings "esbuild output is usable" under test protection.

## Consequences

### Positive
- **Type safety**: `chrome.*` (`@types/chrome`), bridge messages, and DEFAULTS all have compile-time constraints; adding tools/refactoring no longer relies on runtime trial and error.
- **Static checking**: strict + ESLint block implicit any, unused variables, and misspelled branches.
- **Maintainable**: the source lives under `src/`, and is modularizable and extensible.
- **Simple pipeline**: one `build.mjs` + the single esbuild dependency, with no config sprawl.

### Negative
- **The install/load flow changed**: the load-unpacked target changed from `extension/` to **`extension/dist/`**, and dist/ is a build artifact (already gitignored). **After editing code you must first run `npm run build` (or `just ext-build`) and then reload the extension** — you can no longer just edit a `.js` file and have it take effect as before. `install.sh` was also changed to build first and then load from dist/.
- **One more build dependency**: developing the extension requires Node + `npm ci`; esbuild/typescript/eslint and the like go into devDependencies.
- **Artifacts are not committed**: dist/ is not committed, so after cloning you must build before you can load it.

### Neutral
- esbuild does no type checking; type/lint/format exist as separate CI gates (see ADR-0013) — the responsibilities are clear but must be run separately.

## Implementation

- `extension/src/{background,content,options,popup}.ts`: strict TypeScript source.
- `extension/build.mjs`: the esbuild driver, bundling the four entry points into IIFEs to dist/ and copying static assets; `--watch` supports incremental builds.
- `extension/tsconfig.json`: `strict`, `noEmit`, `types: ["chrome"]`, `moduleResolution: bundler`.
- `extension/package.json`: `build` / `watch` / `typecheck` / `lint` / `format` scripts; devDependencies include esbuild, typescript, @types/chrome, eslint, prettier, typescript-eslint.
- `.gitignore`: excludes `extension/dist` and `extension/node_modules`.
- `tests/dom_test.ts`: reads `extension/dist/content.js` (the build artifact).
- `install.sh` / `README`: builds the extension and load-unpacked from dist/.

## Relationship to Other ADRs

- **[ADR-0001](./0001-use-rust-single-binary.md)**: that ADR covers only the Rust backend's "single binary, zero runtime dependencies"; introducing a build step on the extension side is a parallel, separate artifact chain that does not affect how the backend is distributed.
- **[ADR-0013](./0013-ci-and-toolchain.md)**: the typecheck/lint/format/build established by this ADR are all gatekept uniformly by the CI extension job.
