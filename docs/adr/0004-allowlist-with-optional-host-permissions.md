# ADR-0004: Allowlist + optional host permissions with on-demand granting

- **Status**: Accepted
- **Date**: 2026-07-07

## Background

For AI to operate the user's real browser, **the most dangerous capability** is that it can click/fill any page — especially banks, email, and already-logged-in admin backends. Once the AI's instructions are subverted (prompt injection, model error), it could steal tokens, execute transfers, or leak private data.

We need a permission model to control "which sites the AI can operate on".

## Decision

**Adopt a domain allowlist + on-demand granting, implemented via `optional_host_permissions` + runtime `chrome.permissions.request`:**

1. **Manifest declaration**: `host_permissions: []` (no domain permissions initially) + `optional_host_permissions: ["<all_urls>"]` (can be requested at runtime)
2. **No manifest content_scripts**: everything is injected dynamically via `chrome.scripting.executeScript` (otherwise static matches would not inject at all without host permissions)
3. **First operation on a new domain**: the extension shows a popup, and when the user clicks Allow it **simultaneously**:
   - Calls `chrome.permissions.request({origins: [pattern]})` to request host permission for that domain
   - Adds the domain to the allowlist in `chrome.storage.local`
4. **Allowlist is revocable**: the popup shows the list of authorized domains, which can be revoked one by one
5. **Persistence**: the allowlist is stored in `chrome.storage.local` and survives SW restarts

## Alternatives Considered

### Option A: Static host_permissions: ["<all_urls>"] (grant all at install time)
- **Pros**: simplest to implement; content scripts auto-inject into all pages
- **Cons**:
  - Shows a "Read and change all your data on all websites" warning at install time, deterring users
  - Violates the "least privilege" principle — the AI can instantly operate on all sites, including banks
  - No on-demand control
- **Rejected**: the user explicitly chose the allowlist approach

### Option B: Blocklist + confirmation for critical actions
- **Mechanism**: open all sites by default, build a blocklist for banks/payments/etc.; confirm high-risk actions in real time
- **Pros**: smooth experience, no need to add a permission for each new site
- **Cons**: requires maintaining the blocklist (bank domains are numerous and change); large default attack surface; relies on the user staying vigilant
- **Rejected**: the user chose the allowlist when making the decision (more secure)

### Option C: Fully open (local only)
- **Mechanism**: no domain restrictions, no secondary confirmation, since it's all on the local machine anyway
- **Cons**: security depends entirely on trusting every AI instruction; no protection against prompt-injection risk
- **Rejected**: the user explicitly did not choose this

## Consequences

### Positive
- **Least privilege**: by default the AI can operate on nothing; every new site requires the user to actively grant permission
- **Fine-grained revocation**: the user can revoke a domain in the popup at any time
- **Aligned with Chrome's permission model**: uses Chrome's native `optional_host_permissions` + `permissions.request`, in line with MV3 best practices
- **Persistent allowlist**: storage.local survives SW restarts

### Negative
- **Friction on first use**: each new site requires a click on the popup to grant permission
- **User gesture required**: `permissions.request` can only be called in a popup/action click context, not from the service worker background — so granting must go through the popup UI
- **Badge prompt mechanism**: when a grant is requested, the action badge is set to "!"; the user must actively click the extension icon to open the popup (auto-rejects after 60 seconds of no response)
- **Cost of not using manifest content_scripts**: `injectIfNeeded` is required (ping first, then `executeScript` on failure), adding one extra round trip

### Neutral
- The allowlist's "domain" granularity is an origin glob (e.g., `https://example.com/*`), not an exact URL, which is sufficient for the vast majority of scenarios

## Implementation Details

- `extension/manifest.json`: `permissions: [tabs, scripting, storage, nativeMessaging]` (no activeTab, because background injection is needed); `host_permissions: []`; `optional_host_permissions: ["<all_urls>"]`; **no content_scripts field**
- `extension/background.js`:
  - `ensureAllowed(url)`: checks whether the origin glob is in the allowlist; if not, `promptUserForAllow` (sets badge + stores `pendingAllow` + 60s timeout)
  - `injectIfNeeded(tabId)`: pings the content script, and on failure runs `chrome.scripting.executeScript`
- `extension/popup.js`: on `resolvePending`, calls `chrome.permissions.request({origins: [pattern]})` + records the allowlist

## Design Notes

**Why not use manifest content_scripts + static matches**: In MV3, even if the manifest declares content_scripts matches, the content script **will not inject** if the corresponding domain is not in host_permissions (or an already-granted optional permission). So static matches paired with an initially empty host_permissions are completely ineffective. Switching to dynamic injection makes permissions follow the optional grants entirely — inject into whichever domain is authorized, keeping the logic clear.

## Relationship to ADR-0006

The allowlist controls "which sites can be operated on", while Toast confirmation ([ADR-0006](./0006-toast-confirmation-for-high-risk.md)) controls "which actions within an authorized site require secondary confirmation". The two layers of defense complement each other: the allowlist guards against unfamiliar sites, and Toast guards against dangerous actions on already-authorized sites.
