// Unit tests for the changelog generator's pure helpers.
// Run: node --test scripts/   (Node's built-in runner — no new dependency)

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCommits, renderSection } from "./changelog-gen.mjs";

const REC = (subject, body = "") => `${subject}\n${body}\x1e`;

test("parses type, scope and description", () => {
  const [c] = parseCommits(REC("feat(cdp): read every frame (#118)"));
  assert.equal(c.type, "feat");
  assert.equal(c.scope, "cdp");
  assert.equal(c.desc, "read every frame (#118)");
  assert.equal(c.breaking, false);
});

test("recognises both breaking-change spellings", () => {
  assert.equal(parseCommits(REC("feat!: drop the allowlist"))[0].breaking, true);
  assert.equal(
    parseCommits(REC("refactor: rework refs", "BREAKING CHANGE: refs are renamed"))[0].breaking,
    true
  );
  // A body that merely mentions the phrase mid-sentence is not a trailer.
  assert.equal(
    parseCommits(REC("fix: tidy", "this is not a BREAKING CHANGE: really"))[0].breaking,
    false
  );
});

// Merge commits and anything hand-written outside the convention must not
// produce a garbled bullet — they are simply not release notes.
test("skips commits that are not Conventional Commits", () => {
  assert.deepEqual(parseCommits(REC("Merge branch 'main' into x")), []);
  assert.deepEqual(parseCommits(REC("WIP")), []);
  assert.equal(parseCommits("").length, 0);
});

test("groups types into Keep a Changelog sections, in canonical order", () => {
  const commits = parseCommits(
    REC("fix: b") + REC("feat: a") + REC("ci: c") + REC("docs: d")
  );
  const out = renderSection("1.2.3", "2026-01-01", commits);
  assert.match(out, /^## \[1\.2\.3\] - 2026-01-01$/m);
  // Added before Changed before Fixed, whatever order the commits arrived in.
  assert.ok(out.indexOf("### Added") < out.indexOf("### Changed"));
  assert.ok(out.indexOf("### Changed") < out.indexOf("### Fixed"));
  assert.match(out, /### Added\n- a/);
  assert.match(out, /### Fixed\n- b/);
});

// `test` and `style` commits are real work but are not what a reader of release
// notes wants; dropping them is deliberate, so pin it.
test("drops types that are not user-facing", () => {
  const out = renderSection("1.0.0", "2026-01-01", parseCommits(REC("test: add cases")));
  assert.match(out, /_No user-facing changes\._/);
  assert.doesNotMatch(out, /add cases/);
});

test("surfaces breaking changes above the sections", () => {
  const out = renderSection("2.0.0", "2026-01-01", parseCommits(REC("feat!: rename every ref")));
  assert.ok(out.indexOf("Breaking changes") < out.indexOf("### Added"));
  assert.match(out, /> - rename every ref/);
});

test("folds a scope into the bullet", () => {
  const out = renderSection("1.0.0", "2026-01-01", parseCommits(REC("fix(qa): flaky suite")));
  assert.match(out, /- \*\*qa\*\*: flaky suite/);
});
