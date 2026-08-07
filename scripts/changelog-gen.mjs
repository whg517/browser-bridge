// Generate a CHANGELOG section from the Conventional Commits since the last tag.
//
//   node scripts/changelog-gen.mjs 0.7.0            print the section
//   node scripts/changelog-gen.mjs 0.7.0 --write    insert it into CHANGELOG.md
//   node scripts/changelog-gen.mjs 0.7.0 --since v0.6.0
//
// WHY THIS EXISTS
//
// Every PR used to append to the same `## [Unreleased]` block, so any two open
// PRs conflicted there, and merging one forced a rebase of every other — O(N²)
// conflict resolutions for N parallel branches. Three separate rebases of one
// PR in a single afternoon is what prompted this.
//
// `main` is squash-merged and commit subjects are enforced Conventional Commits
// (CONTRIBUTING.md), so one PR is exactly one commit and its subject is already
// the changelog line. Generating from `git log` removes the shared file from the
// PR path entirely: nothing to conflict over.
//
// The trade: entries are now one line each. The multi-paragraph "why" that used
// to live in CHANGELOG.md now lives only in the commit body — still permanent,
// still greppable via `git log`, but not in the published notes. That was an
// accepted cost of the change, not an oversight.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

// Conventional Commit type → Keep a Changelog section. Types absent from this
// map are dropped: `test`, `style` and `chore`-adjacent work is real but is not
// what a reader of release notes is looking for. `ci`/`build` DO appear, because
// in this project they routinely change how the thing is released or installed.
const SECTION = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  docs: "Changed",
  build: "Changed",
  ci: "Changed",
  revert: "Changed",
};
// Keep a Changelog's canonical order, so sections never shuffle between releases.
const ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<desc>.+)$/;

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** Parse `git log` output into {type, scope, breaking, desc, body}. */
export function parseCommits(raw) {
  return raw
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [subject, ...bodyLines] = rec.split("\n");
      const m = SUBJECT.exec(subject.trim());
      if (!m) return null; // not a Conventional Commit (e.g. a merge) — skip
      const body = bodyLines.join("\n");
      return {
        type: m.groups.type,
        scope: m.groups.scope || null,
        // `feat!:` or a `BREAKING CHANGE:` trailer, per the spec.
        breaking: Boolean(m.groups.bang) || /^BREAKING CHANGE:/m.test(body),
        desc: m.groups.desc.trim(),
        body,
      };
    })
    .filter(Boolean);
}

/** Render commits as a dated Keep a Changelog section. */
export function renderSection(version, date, commits) {
  const buckets = new Map();
  const breaking = [];
  for (const c of commits) {
    if (c.breaking) breaking.push(c);
    const section = SECTION[c.type];
    if (!section) continue;
    if (!buckets.has(section)) buckets.set(section, []);
    // The scope is useful context ("ci", "qa") but reads as noise in a bullet,
    // so it is folded in only when present.
    buckets.get(section).push(c.scope ? `**${c.scope}**: ${c.desc}` : c.desc);
  }

  const out = [`## [${version}] - ${date}`, ""];
  if (breaking.length) {
    out.push("> **Breaking changes**", ">");
    for (const c of breaking) out.push(`> - ${c.desc}`);
    out.push("");
  }
  for (const section of ORDER) {
    const items = buckets.get(section);
    if (!items?.length) continue;
    out.push(`### ${section}`);
    for (const i of items) out.push(`- ${i}`);
    out.push("");
  }
  if (buckets.size === 0 && !breaking.length) {
    out.push("_No user-facing changes._", "");
  }
  return out.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith("--"));
  if (!version) {
    console.error("usage: changelog-gen.mjs <version> [--since <tag>] [--write]");
    process.exit(2);
  }
  const sinceIdx = args.indexOf("--since");
  const since =
    sinceIdx >= 0 ? args[sinceIdx + 1] : git("describe", "--tags", "--abbrev=0").trim();

  const raw = git("log", "--no-merges", "--format=%s%n%b%x1e", `${since}..HEAD`);
  const commits = parseCommits(raw);
  const date = new Date().toISOString().slice(0, 10);
  const section = renderSection(version, date, commits);

  if (!args.includes("--write")) {
    console.error(`# ${commits.length} commit(s) since ${since}`);
    process.stdout.write(section);
    return;
  }

  const md = readFileSync(CHANGELOG, "utf8");
  const anchor = "## [Unreleased]\n";
  if (!md.includes(anchor)) {
    console.error("CHANGELOG.md has no '## [Unreleased]' anchor to insert under");
    process.exit(1);
  }
  if (md.includes(`## [${version}]`)) {
    console.error(`CHANGELOG.md already has a '## [${version}]' section`);
    process.exit(1);
  }
  // Anything already sitting under [Unreleased] was hand-written before this
  // generator existed, and its commits are about to be regenerated below it —
  // say so rather than silently producing the same change twice.
  const unreleased = md.slice(md.indexOf(anchor) + anchor.length);
  const leftover = unreleased.slice(0, unreleased.indexOf("\n## [")).trim();
  if (leftover) {
    console.error(
      "warning: [Unreleased] already has hand-written entries. The generated section " +
        "is inserted above them; fold the two together and delete the leftovers."
    );
  }

  writeFileSync(CHANGELOG, md.replace(anchor, `${anchor}\n${section}`));
  console.error(`inserted '## [${version}]' from ${commits.length} commit(s) since ${since}`);
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && process.argv[1].endsWith("changelog-gen.mjs")) main();
