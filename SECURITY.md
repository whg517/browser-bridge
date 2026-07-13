# Security Policy

browser-bridge drives a **real, logged-in Chrome** on the user's machine — it
can read page content, cookies (including httpOnly), and web storage, and can
execute JavaScript in pages. Security is a first-class concern, not an
afterthought. This document covers how to report issues and the review bar for
security-relevant changes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's **[Report a vulnerability](https://github.com/whg517/browser-bridge/security/advisories/new)**
(Security → Advisories) on this repository. Include:

- what an attacker can do (impact) and the trust boundary crossed,
- reproduction steps or a proof of concept,
- affected version / commit.

Expect an acknowledgement within a few days. Because this is a small project,
please allow reasonable time for a fix before any public disclosure.

## Scope

In scope: the Rust binary (MCP server + native host), the native-messaging
bridge and its auth, the MV3 extension (background/content), the allowlist and
confirmation model, masking, and the installer.

Examples of in-scope issues: bypassing the site allowlist or a confirmation
prompt; exfiltrating cookies/storage/page content past the mask; a page
influencing the extension into acting on a non-approved origin; the bridge
socket accepting an unauthenticated peer; privilege escalation via the native
messaging host.

Out of scope: anything requiring a pre-compromised machine or a malicious MCP
client the user themselves configured (the MCP client is trusted by design —
see the [threat model](docs/security/threat-model.md)).

## The security model (summary)

See [docs/security/](docs/security/) for the full picture:

- [threat-model.md](docs/security/threat-model.md) — actors, assets, what's
  trusted vs not.
- [trust-boundaries.md](docs/security/trust-boundaries.md) — the process/protocol
  boundaries and how each is enforced.
- [tool-risk-matrix.md](docs/security/tool-risk-matrix.md) — every tool's blast
  radius and protections.

Key invariants:

- **stdout is protocol** — the binary never prints diagnostics there; only
  framed/NDJSON messages (a stray write corrupts the stream).
- **Read-only credential access** — cookies/storage can be read (masked), never
  written. There is no `cookie_set`/`storage_set` by design.
- **Approve-per-origin + confirm high-risk** — page ops need an allowlisted
  origin; submit/link clicks, `page_eval`, and tab close prompt the user.
- **Bridge auth** — the localhost TCP bridge authenticates each connection with
  a per-run secret from a 0600 lock file.

## Security-relevant changes (review bar)

A change is **security-relevant** — and must carry the
[security-change](.github/ISSUE_TEMPLATE/security-change.yml) checklist, update
the [tool risk matrix](docs/security/tool-risk-matrix.md), and (if it moves a
trust boundary) the [threat model](docs/security/threat-model.md) — if it:

- adds/broadens a Chrome permission or host permission,
- adds a way to read new sensitive data, or any write capability,
- changes confirmation, allowlist, or masking logic,
- changes native-messaging auth, the lock file, or the run secret,
- adds outbound network/IPC, or widens `page_eval`.

Such PRs should add a **negative** security test (proving the boundary holds),
not just a positive one.

## Supported versions

Pre-1.0: only the latest release is supported. Security fixes ship in a new
patch/minor release.
