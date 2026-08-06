//! What the extension tells us about itself on connect, and what we do when it
//! disagrees with this binary.
//!
//! # Why this exists
//!
//! The host binary and the extension are upgraded through completely separate
//! channels: the binary by hand (a release tarball or `install.sh`), the
//! extension automatically by the Chrome Web Store. Drifting apart is therefore
//! the *normal* steady state after any release, not an edge case. Before this
//! module nothing on the wire carried the extension's version, so a mismatch
//! surfaced to the agent as an unexplained "unknown op" or a tool that quietly
//! did nothing.
//!
//! # The announce frame
//!
//! On connect the extension sends one frame shaped exactly like a [`BridgeResp`]
//! on the reserved id [`ANNOUNCE_ID`] (`0`), carrying its payload under
//! `data.announce`:
//!
//! ```json
//! {"id":0,"ok":true,"data":{"announce":{
//!   "protocolVersion":1,"version":"0.6.0",
//!   "browser":{"name":"Chrome","version":"141.0.7390.55"}}}}
//! ```
//!
//! Riding on the response envelope is deliberate. "Old binary + new extension"
//! is precisely the drift we are trying to detect, so the frame must not break
//! an older server: a bare `{"type":"announce",…}` line would fail to
//! deserialize into `BridgeResp` (whose `id`/`ok` are required), and that error
//! kills the reader loop and tears the connection down — the extension would
//! then reconnect-loop forever. As a `BridgeResp` on id 0 it parses cleanly on
//! any version; `Session::next_id` starts at 1, so no real request can collide,
//! and a server that predates this module simply finds no pending caller for id
//! 0, logs that, and carries on.
//!
//! [`BridgeResp`]: crate::protocol::BridgeResp

use serde::Deserialize;
use serde_json::Value;

/// The reserved `BridgeResp.id` an announce frame rides on. Never a real request
/// id: `Session::next_id` starts at 1.
pub const ANNOUNCE_ID: u64 = 0;

/// The internal bridge protocol version this binary speaks. The single source of
/// truth is `contracts/protocol-version.json`; the test below keeps them equal.
pub const PROTOCOL_VERSION: u64 = 1;

/// What the extension advertised about itself. Every field is optional: an
/// extension older than this feature announces nothing at all, and a newer one
/// may add fields we do not know about yet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    /// The bridge protocol version the extension speaks. Recorded and reported;
    /// never enforced — see the module docs on `PROTOCOL_MISMATCH`.
    #[serde(default)]
    pub protocol_version: Option<u64>,
    /// The extension's own release version (`chrome.runtime.getManifest()`).
    #[serde(default)]
    pub version: Option<String>,
    /// The browser the extension is running in, e.g. "Chrome 141.0.7390.55".
    #[serde(default)]
    pub browser: Option<Browser>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Browser {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

impl Browser {
    /// "Chrome 141.0.7390.55", or as much of it as was advertised.
    pub fn label(&self) -> Option<String> {
        match (&self.name, &self.version) {
            (Some(n), Some(v)) => Some(format!("{n} {v}")),
            (Some(n), None) => Some(n.clone()),
            (None, Some(v)) => Some(v.clone()),
            (None, None) => None,
        }
    }
}

/// Extract the announce payload from a `BridgeResp`'s `data`, if it carries one.
/// Returns `None` for an ordinary response, so a real id-0 collision (there is
/// no such thing today, but be defensive) falls through to normal routing.
pub fn parse_announce(data: Option<&Value>) -> Option<PeerInfo> {
    let announce = data?.get("announce")?;
    serde_json::from_value(announce.clone()).ok()
}

/// The version this binary was built as. `0.0.0` means "built locally, not a
/// release" (ADR-0026).
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The placeholder version the repo carries between releases (ADR-0026).
const PLACEHOLDER: &str = "0.0.0";

/// Compare the host and extension versions and produce the advisory the agent
/// should see, or `None` when there is nothing worth saying.
///
/// Deliberately quiet cases:
/// - the two versions are equal;
/// - either side is the `0.0.0` placeholder, i.e. somebody is running their own
///   build. Mixing a local build with a released counterpart is a normal thing
///   to do while developing, and nagging about it on every reconnect would train
///   agents to ignore the message that matters.
pub fn drift_advisory(host: &str, peer: &PeerInfo) -> Option<String> {
    let ext = peer.version.as_deref()?;
    if ext == host || ext == PLACEHOLDER || host == PLACEHOLDER {
        return None;
    }
    // A prerelease host legitimately pairs with an extension reporting only the
    // numeric core: Chrome's manifest accepts nothing but dot-separated
    // integers, so `v0.6.0-rc.2` is stamped there as `0.6.0` (ADR-0026). Host
    // 0.6.0-rc.2 + extension 0.6.0 is therefore the SAME build, not drift.
    //
    // Without this, every prerelease user was told to "update whichever side is
    // behind" on a matched pair — an advisory that cries wolf teaches agents to
    // skip past the one that matters. Found by QA against a real browser running
    // the v0.6.0-rc.2 release.
    if ext == version_core(host) {
        return None;
    }

    let direction = match (parse_semver(host), parse_semver(ext)) {
        (Some(h), Some(e)) if e < h => {
            "The extension is older than the host binary — update the extension \
             (Chrome Web Store, or reload the unpacked build)."
        }
        (Some(h), Some(e)) if e > h => {
            "The host binary is older than the extension — update the binary \
             (re-run install.sh, or download the matching release)."
        }
        // Equal cores with different pre-release suffixes, or an unparsable
        // version on either side: say what we know and nothing more.
        _ => "Update whichever side is behind so the two match.",
    };

    Some(format!(
        "[browser-bridge] Version mismatch: the native host binary is v{host} \
         but the connected Chrome extension is v{ext}. Tools added or changed \
         since the older of the two may fail or behave unexpectedly. {direction} \
         Tell the user about this; do not try to work around it silently."
    ))
}

/// Parse `MAJOR.MINOR.PATCH`, ignoring any pre-release/build suffix. Returns
/// `None` if the version is not in that shape, in which case the caller must not
/// claim a direction. Sufficient for ordering *our own* release versions; this
/// is not a general SemVer implementation (pre-release precedence is not
/// modelled — see the `_` arm in [`drift_advisory`]).
/// The numeric part of a version: `0.6.0-rc.2` -> `0.6.0`. This is exactly what
/// the extension manifest is stamped with (ADR-0026).
fn version_core(v: &str) -> &str {
    v.split(['-', '+']).next().unwrap_or(v)
}

fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let core = version_core(v);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// A one-line summary for the logs / diagnostics.
pub fn describe(peer: &PeerInfo) -> String {
    let version = peer.version.as_deref().unwrap_or("unknown");
    let protocol = peer
        .protocol_version
        .map_or_else(|| "unknown".to_string(), |p| p.to_string());
    let browser = peer
        .browser
        .as_ref()
        .and_then(Browser::label)
        .unwrap_or_else(|| "unknown".to_string());
    format!("extension v{version} (protocol {protocol}, {browser})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // contracts/protocol-version.json is the single source of truth for the
    // internal bridge protocol version. Mirrors the parity tests in error.rs and
    // tools/catalogue.rs so the constant can never silently drift from the
    // contract the extension also generates from.
    #[test]
    fn protocol_version_matches_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../contracts/protocol-version.json")).unwrap();
        assert_eq!(
            contract["protocolVersion"].as_u64(),
            Some(PROTOCOL_VERSION),
            "PROTOCOL_VERSION must equal contracts/protocol-version.json"
        );
    }

    #[test]
    fn parses_a_full_announce() {
        let data = json!({"announce": {
            "protocolVersion": 1,
            "version": "0.6.0",
            "browser": {"name": "Chrome", "version": "141.0.7390.55"}
        }});
        let peer = parse_announce(Some(&data)).expect("announce parses");
        assert_eq!(peer.protocol_version, Some(1));
        assert_eq!(peer.version.as_deref(), Some("0.6.0"));
        assert_eq!(
            peer.browser.as_ref().and_then(Browser::label).as_deref(),
            Some("Chrome 141.0.7390.55")
        );
    }

    // Forward compatibility: a newer extension may announce fields this binary
    // has never heard of, and may omit ones it does know. Neither may break the
    // parse, or the drift we are trying to report would take the connection down.
    #[test]
    fn tolerates_missing_and_unknown_fields() {
        let peer = parse_announce(Some(&json!({"announce": {"version": "0.7.0",
            "capabilities": ["tab_control"], "somethingNew": 42}})))
        .expect("partial announce parses");
        assert_eq!(peer.version.as_deref(), Some("0.7.0"));
        assert_eq!(peer.protocol_version, None);
        assert!(peer.browser.is_none());

        // An empty announce object is still an announce (peer connected, told us
        // nothing) — distinct from "no announce frame at all".
        assert_eq!(
            parse_announce(Some(&json!({"announce": {}}))),
            Some(PeerInfo::default())
        );
    }

    #[test]
    fn ignores_data_without_an_announce() {
        assert!(parse_announce(None).is_none());
        assert!(parse_announce(Some(&json!({"tabs": []}))).is_none());
        assert!(parse_announce(Some(&json!("not an object"))).is_none());
    }

    fn peer_at(version: &str) -> PeerInfo {
        PeerInfo {
            version: Some(version.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn silent_when_versions_agree() {
        assert!(drift_advisory("0.6.0", &peer_at("0.6.0")).is_none());
    }

    // A prerelease host and an extension carrying only the numeric core are the
    // SAME build: Chrome's manifest cannot hold the suffix, so ADR-0026 stamps
    // the core there. Shipped as a false positive in v0.6.0-rc.2 and caught by
    // QA against a real browser — every prerelease user saw a bogus "update
    // whichever side is behind" on a perfectly matched pair.
    #[test]
    fn silent_when_the_extension_carries_only_the_hosts_core() {
        for host in ["0.6.0-rc.2", "0.6.0-rc.1", "1.2.3-alpha.1", "1.2.3+build.5"] {
            let core = host.split(['-', '+']).next().unwrap();
            assert!(
                drift_advisory(host, &peer_at(core)).is_none(),
                "{host} vs {core} is one build, not drift"
            );
        }
    }

    // ...but a prerelease of a DIFFERENT version is still real drift.
    #[test]
    fn prerelease_does_not_mask_a_genuine_mismatch() {
        let behind = drift_advisory("0.7.0-rc.1", &peer_at("0.6.0")).expect("advisory");
        assert!(behind.contains("extension is older"), "{behind}");
        let ahead = drift_advisory("0.6.0-rc.1", &peer_at("0.7.0")).expect("advisory");
        assert!(ahead.contains("host binary is older"), "{ahead}");
    }

    #[test]
    fn version_core_strips_prerelease_and_build_metadata() {
        assert_eq!(version_core("0.6.0-rc.2"), "0.6.0");
        assert_eq!(version_core("1.2.3+build.5"), "1.2.3");
        assert_eq!(version_core("1.2.3"), "1.2.3");
    }

    // A locally-built side is the developer's own doing; see drift_advisory.
    #[test]
    fn silent_when_either_side_is_the_placeholder() {
        assert!(drift_advisory("0.0.0", &peer_at("0.0.0")).is_none());
        assert!(drift_advisory("0.0.0", &peer_at("0.6.0")).is_none());
        assert!(drift_advisory("0.6.0", &peer_at("0.0.0")).is_none());
    }

    // An extension that predates the announce frame tells us nothing; treat it
    // as legacy and stay quiet rather than guessing.
    #[test]
    fn silent_when_the_peer_announced_no_version() {
        assert!(drift_advisory("0.6.0", &PeerInfo::default()).is_none());
    }

    #[test]
    fn names_the_side_that_is_behind() {
        let ext_behind = drift_advisory("0.6.0", &peer_at("0.5.0")).expect("advisory");
        assert!(ext_behind.contains("v0.6.0") && ext_behind.contains("v0.5.0"));
        assert!(
            ext_behind.contains("extension is older"),
            "should point at the extension: {ext_behind}"
        );

        let host_behind = drift_advisory("0.5.0", &peer_at("0.6.0")).expect("advisory");
        assert!(
            host_behind.contains("host binary is older"),
            "should point at the binary: {host_behind}"
        );
    }

    // Unparsable or same-core-different-suffix versions still get an advisory —
    // just without a claim about which side is behind, which we cannot order.
    #[test]
    fn advises_without_a_direction_when_ordering_is_unclear() {
        for (host, ext) in [
            ("0.6.0", "0.6.0-rc.1"),
            ("0.6.0", "nightly"),
            ("x", "0.6.0"),
        ] {
            let msg = drift_advisory(host, &peer_at(ext))
                .unwrap_or_else(|| panic!("expected an advisory for {host} vs {ext}"));
            assert!(msg.contains("whichever side is behind"), "{msg}");
        }
    }

    #[test]
    fn parse_semver_rejects_non_triples() {
        assert_eq!(parse_semver("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("1.2.3-rc.1"), Some((1, 2, 3)));
        assert_eq!(parse_semver("1.2"), None);
        assert_eq!(parse_semver("1.2.3.4"), None);
        assert_eq!(parse_semver(""), None);
    }

    #[test]
    fn describe_fills_in_unknowns() {
        assert_eq!(
            describe(&PeerInfo::default()),
            "extension vunknown (protocol unknown, unknown)"
        );
    }
}
