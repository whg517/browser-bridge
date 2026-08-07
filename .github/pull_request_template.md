<!-- Keep it short. Delete sections that don't apply. -->

## What & why

<!-- The change and the problem it solves. -->

## Areas touched

- [ ] Rust MCP server
- [ ] Native host
- [ ] Extension (background / content)
- [ ] Protocol / bridge
- [ ] Permissions / security
- [ ] Installer / release
- [ ] Docs / CI

## Tests

- [ ] Rust unit
- [ ] Extension unit / typecheck / lint
- [ ] Protocol e2e
- [ ] DOM / smoke
- [ ] Manual Chrome verification (if behavior changed)

## Security-relevant?

If this touches permissions, credential access, confirmation,
masking, bridge auth, or `page_eval` (see [SECURITY.md](../SECURITY.md)):

- [ ] Not security-relevant
- [ ] Updated the [tool risk matrix](../docs/security/tool-risk-matrix.md)
- [ ] Updated the [threat model](../docs/security/threat-model.md) (if a trust boundary moved)
- [ ] Added a **negative** test

## Housekeeping

- [ ] Commit subject reads well as a release-notes line (the CHANGELOG is
      generated from it; see CONTRIBUTING.md)
- [ ] ADR added / not needed
- [ ] No unexplained `any` / `unwrap()` / new permission
