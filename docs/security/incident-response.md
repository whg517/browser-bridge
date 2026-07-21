# Incident Response Runbook

> A realistic security incident handling process for a single-maintainer project, kept consistent with the reporting channel in [SECURITY.md](../../SECURITY.md) and the
> assets/trust boundaries in [threat-model.md](threat-model.md). Trust boundaries are enumerated in
> [trust-boundaries.md](trust-boundaries.md), and tool risks in [tool-risk-matrix.md](tool-risk-matrix.md).

## What counts as a security incident

The compromise or suspected compromise of a protected asset from [threat-model.md](threat-model.md), for example:

- Bypassing the site allowlist or the confirmation prompt to perform page actions on an **unauthorized origin**;
- Leaking cookies / storage / page content / eval return values past redaction;
- The bridge socket accepting an **unauthenticated** local peer, or the host manifest's `allowed_origins` being modified;
- `page_eval` or its confirmation channel being abused to produce irreversible consequences.

Not an incident: anything that requires the machine to be compromised beforehand, or a malicious MCP client the user configured themselves (trusted by design, see
[SECURITY.md's Scope](../../SECURITY.md#scope)).

## Reporting channel

**Do not open a public issue for security problems.** Use GitHub's
**[Report a vulnerability](https://github.com/whg517/browser-bridge/security/advisories/new)**
(Security → Advisories) for a private report, including: what an attacker can do (impact) and the trust boundary crossed,
reproduction steps or a PoC, and the affected version/commit. As a small project, we will acknowledge within a few days and request a reasonable fix window.

## Triage

After receiving a report, prioritize it using the following questions (aligned with the blast radius in [tool-risk-matrix.md](tool-risk-matrix.md)):

1. **Which trust boundary was crossed?** (see [trust-boundaries.md](trust-boundaries.md) ①–④; ④, the page boundary, is the most critical)
2. **What can be read/modified?** Does it reach credentials (cookie/storage token)? Are there write/irreversible consequences?
3. **How strong are the preconditions?** Does it require the user to have already authorized an origin, to have the extension installed, or to be local with the same UID?
4. **Is it reproducible?** Is there a PoC?

Use this to decide between "immediate mitigation" and "scheduled fix." Credential leaks or allowlist/confirmation bypasses are the highest priority.

## Immediate mitigation (user side, no code changes)

These are actions the user can take on their own to **contain the blast radius** before a patch is ready:

- **Disable a single tool**: on the extension's Options page, add the offending tool to `disabledTools`
  (corresponding to `TOOL_DISABLED`, see [errors.json](../../contracts/errors.json)); high-risk tools such as
  `page_eval` should be disabled first.
- **Revoke the allowlist / turn off all sites**: in Options / popup, remove the authorization for the relevant origin, and confirm that
  `allowAllSites` is off (see [ADR-0004](../adr/0004-allowlist-with-optional-host-permissions.md),
  [ADR-0011](../adr/0011-options-page-for-settings.md)). Removing the authorization also revokes that origin's
  host permission.
- **Kill switch**: in `chrome://extensions`, disable or remove the Browser Bridge extension—once the
  extension stops, the native host receives a stdin EOF and exits, and the bridge is severed. If necessary, also exit the MCP client session
  to let the MCP server process terminate (use `doctor` to confirm it is not reachable, see [operations.md](../operations.md)).
- **Uninstall the host manifest**: after the native messaging host manifest is deleted, Chrome can no longer spawn the host
  (path in [architecture.md §4.3](../architecture.md#43-installation-artifacts)).

> Mitigation priority: disable high-risk tools first → revoke the allowlist → disable the extension → uninstall the manifest, from lightest to heaviest.

## Fix and verification

- Locate the **invariant** that was crossed (see ["invariants that must not regress" in trust-boundaries.md](trust-boundaries.md#invariants-that-must-not-regress)).
- The fix goes through the **security-relevant change** gate: complete the [security-change checklist](../../.github/ISSUE_TEMPLATE/security-change.yml),
  update [tool-risk-matrix.md](tool-risk-matrix.md), and if a trust boundary changed, also update [threat-model.md](threat-model.md).
- **A negative security test must be added** to prove the boundary holds again (not just a positive test case), in line with the [review bar in SECURITY.md](../../SECURITY.md#security-relevant-changes-review-bar).

## Release and disclosure

- Tag and release the fix per [release.md](../release.md); pre-1.0 only supports the latest release
  (see [Supported versions in SECURITY.md](../../SECURITY.md#supported-versions)), and security fixes ship as a new
  patch/minor.
- Coordinate disclosure through a GitHub Security Advisory: go public only after giving the reporter a reasonable fix window, and after release, acknowledge the reporter in the advisory
  and describe the affected versions and mitigations.
- Record the fix in [CHANGELOG.md](../../CHANGELOG.md).

## See Also

- Reporting channel and review bar: [SECURITY.md](../../SECURITY.md).
- Assets, actors, non-goals: [threat-model.md](threat-model.md).
- Boundaries and invariants: [trust-boundaries.md](trust-boundaries.md).
- Operations and diagnostics: [operations.md](../operations.md).
