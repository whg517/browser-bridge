# Privacy Policy — Browser Bridge

_Last updated: 2026-07-15_

Browser Bridge is an open-source Chrome extension that connects an MCP client
(such as Claude Code, Claude Desktop, or Codex) to your local Chrome through a
native-messaging host that runs on your own computer. This policy explains what
the extension accesses and what it does — and does not — do with that data.

## Summary

**Browser Bridge does not collect, transmit, or sell any personal data.** It has
no analytics, no telemetry, and no remote servers. Everything the extension does
happens on your own machine, and every sensitive action requires your explicit
approval.

## What the extension can access

To let an approved AI agent operate the pages you are already signed into, the
extension can, **only on sites you have explicitly approved**:

- Read the content of the current page (DOM, text, form fields).
- Read cookies for the active site, including `httpOnly` cookies.
- Read web storage (`localStorage` / `sessionStorage`).
- Execute JavaScript in the page.
- Read the list of open tabs and navigate or close tabs.

Credential-bearing values (cookies and web storage) are **read-only** — the
extension has no API to write or modify cookies or storage by design — and are
**masked** (JWTs, long hex strings, and long digit runs are redacted) before
being returned.

## How that data is used and where it goes

- All communication stays **on your computer**. The extension talks to a local
  native-messaging host over Chrome's native messaging channel; that host talks
  to your MCP client over a localhost-only connection authenticated with a
  per-run secret.
- **No data is ever sent to the extension's authors or to any third-party or
  remote server.** The extension makes no outbound network requests of its own.
- Page content, cookies, and storage that the agent reads are returned to your
  MCP client on the same machine, at your request, for the task you asked it to
  perform.

## Consent and control

- **Per-site approval.** A site does nothing until you approve its origin in a
  popup prompt.
- **Per-action confirmation.** High-risk actions — form submissions, link
  navigations, tab close, and every JavaScript evaluation — require an on-page
  confirmation that you must approve.

## What the extension stores locally

The extension stores a small amount of configuration in Chrome's local
extension storage (`chrome.storage.local`) on your device only:

- Your list of approved sites (the allowlist).
- Your extension settings/preferences.

This data never leaves your device and is removed when you uninstall the
extension.

## Remote code

The extension does **not** load or execute remotely-hosted code. The JavaScript
that may be evaluated in a page is code you (or your MCP client, at your
direction) provide locally — it is never fetched from a remote source.

## Data sharing and sale

Browser Bridge does **not** sell or share your data with anyone. There is no
third party involved.

## Contact

Questions or concerns: please open an issue at
<https://github.com/whg517/browser-bridge/issues>.
