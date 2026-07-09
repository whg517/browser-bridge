// content.js — runs in each page after background.js injects it dynamically.
//
// Receives { op, args } from background.js via chrome.runtime.onMessage and
// performs the actual DOM operation. Sends back a JSON-serializable result,
// or { __error: "..." } on failure.
//
// The snapshot builds an accessibility-style tree of *interactive* elements,
// each tagged with a stable `ref` (`data-zcb-ref="eN"`) that page_click /
// page_fill can target. This is the content-script approximation of a real
// a11y tree — see the project README for why we don't use chrome.debugger
// (the infobar) in v0.1.

(() => {
  if (window.__browserBridgeLoaded) return; // guard against double-inject
  window.__browserBridgeLoaded = true;

  const REF_ATTR = "data-zcb-ref";
  let refCounter = 0;
  // ref -> element, rebuilt on every snapshot. Stale refs (from a previous
  // snapshot whose element has since gone) resolve to null and the caller
  // gets a clear "ref not found, re-snapshot" error.
  let refMap = new Map();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handle(msg)
      .then((data) => sendResponse(data || {}))
      .catch((e) => sendResponse({ __error: String(e?.message || e) }));
    return true; // keep the channel open for the async response
  });

  async function handle(msg) {
    const { op, args } = msg;
    switch (op) {
      case "ping":
        return { pong: true };
      case "page_snapshot":
        return snapshot();
      case "page_click":
        return await click(args);
      case "page_fill":
        return await fill(args);
      case "page_text":
        return text();
      case "page_screenshot":
        return await screenshot();
      case "page_scroll":
        return scroll(args);
      case "page_wait_for":
        return await waitFor(args);
      case "page_eval":
        return await runEval(args);
      case "storage_get":
        return storageGet(args);
      case "_info_toast":
        // Informational toast (e.g. "about to attach debugger, infobar will
        // flash"). Returns true unless the user cancels.
        return await showInfoToast(args.message || "");
      case "_confirm_toast":
        return { approved: await showToast(args.message || "Confirm action?") };
      default:
        throw new Error(`content: unknown op ${op}`);
    }
  }

  // ---- snapshot ----------------------------------------------------------

  function snapshot() {
    // Reset for a fresh, dense ref numbering each call.
    refCounter = 0;
    refMap = new Map();

    const out = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      { acceptNode: (el) => (isInteractive(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) }
    );

    let el = walker.currentNode;
    // TreeWalker's first nextNode() walks from currentNode; start from root.
    while ((el = walker.nextNode())) {
      if (!isVisible(el)) continue;
      const ref = assignRef(el);
      out.push({
        ref,
        role: roleOf(el),
        name: nameOf(el),
        selector: cssSelectorOf(el),
        value: previewValue(el),
      });
    }
    return { refCount: out.length, nodes: out, url: location.href, title: document.title };
  }

  function assignRef(el) {
    // Reuse an existing ref if the element already has one from a prior
    // snapshot (keeps refs stable across calls when the page hasn't
    // changed). When reusing, we MUST advance refCounter past the reused
    // number — otherwise a subsequently-inserted element (no prior ref)
    // would get e1, e2... and collide with the reused refs. This bug shows
    // up on re-snapshot of a page where some elements are new (SPA case).
    let ref = el.getAttribute(REF_ATTR);
    if (ref) {
      const reused = parseInt(ref.slice(1), 10);
      if (!Number.isNaN(reused) && reused > refCounter) refCounter = reused;
    } else {
      refCounter += 1;
      ref = `e${refCounter}`;
      el.setAttribute(REF_ATTR, ref);
    }
    refMap.set(ref, el);
    return ref;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.tabIndex >= 0) return true;
    return false;
  }

  const INTERACTIVE_TAGS = new Set([
    "a", "button", "input", "textarea", "select", "summary", "details",
    "label", "option", "optgroup",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "textbox", "searchbox", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "combobox", "listbox",
    "option", "switch", "treeitem",
  ]);

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "listbox";
    if (tag === "summary") return "button";
    return tag;
  }

  function nameOf(el) {
    // Simplified accessible-name computation (accname-1.2 subset).
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.innerText || n.textContent || "")
        .join(" ")
        .trim();
      if (parts) return truncate(parts, 120);
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return truncate(aria.trim(), 120);
    // <label for> or wrapping <label>
    const labelFor = document.querySelector(`label[for="${el.id}"]`);
    if (labelFor) {
      const t = (labelFor.innerText || "").trim();
      if (t) return truncate(t, 120);
    }
    const wrapping = el.closest("label");
    if (wrapping && wrapping !== labelFor) {
      const t = (wrapping.innerText || "").trim();
      if (t) return truncate(t, 120);
    }
    if (el.title && el.title.trim()) return truncate(el.title.trim(), 120);
    // Fallbacks by content
    const txt = (el.innerText || el.textContent || "").trim();
    if (txt) return truncate(txt, 120);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return truncate(placeholder, 120);
    const alt = el.getAttribute("alt");
    if (alt) return truncate(alt, 120);
    return "";
  }

  function previewValue(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const v = el.value || "";
      if (el.type === "password") return v ? "••••••" : "";
      return truncate(v, 60);
    }
    return undefined;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    // aria-hidden hides the element AND its entire subtree. An element may be
    // visibly styled itself but still hidden from the a11y tree because an
    // ancestor is aria-hidden — walk up to catch that case.
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.getAttribute && cur.getAttribute("aria-hidden") === "true") return false;
      cur = cur.parentElement;
    }
    return true;
  }

  // A cheap, *best-effort* CSS selector. Not guaranteed unique — the AI
  // should prefer `ref`. Used only as a fallback diagnostic.
  function cssSelectorOf(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += `#${cur.id}`;
        parts.unshift(part);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  // ---- resolve ref or selector ------------------------------------------

  function resolveTarget(args) {
    if (args.ref) {
      // Prefer the live map from the most recent snapshot.
      let el = refMap.get(args.ref);
      if (!el) {
        // Fall back to a DOM query by attribute (covers SW-recycle cases
        // where the map was cleared but elements still carry the attr).
        el = document.querySelector(`[${REF_ATTR}="${args.ref}"]`);
        if (el) refMap.set(args.ref, el);
      }
      if (!el) throw new Error(`ref not found: ${args.ref} — call page_snapshot again`);
      return el;
    }
    if (args.selector) {
      const el = document.querySelector(args.selector);
      if (!el) throw new Error(`selector matched nothing: ${args.selector}`);
      return el;
    }
    throw new Error("click/fill needs `ref` or `selector`");
  }

  // ---- click -------------------------------------------------------------

  async function click(args) {
    const el = resolveTarget(args);
    const highRisk = isHighRiskClick(el);
    if (highRisk) {
      // The confirmation gate can be disabled by the user in settings. This is
      // dangerous (ADR-0006) but offered as an explicit opt-in.
      const confirmEnabled = await getSetting("confirmHighRiskClick");
      if (confirmEnabled !== false) {
        await confirmWithToast(`Click "${describeForToast(el)}"?`, describeAction(el, "click"));
      }
    }
    el.scrollIntoView({ block: "center" });
    el.focus?.();
    el.click();
    return { clicked: args.ref || args.selector, role: roleOf(el) };
  }

  function isHighRiskClick(el) {
    // Submit buttons, and links that navigate, are gated.
    const role = roleOf(el);
    if (role === "button") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "submit") return true;
    }
    if (el.tagName === "A" && el.hasAttribute("href")) return true;
    if (role === "link") return true;
    return false;
  }

  // ---- fill --------------------------------------------------------------

  async function fill(args) {
    const el = resolveTarget(args);
    const value = args.__value ?? args.value ?? "";
    // Use the native setter path so frameworks (React, Vue) pick it up.
    await setNativeValue(el, value);
    return { filled: args.ref || args.selector };
  }

  // Setting el.value directly doesn't trigger React/Vue change detection.
  // Use the well-known trick of getting the native setter from the proto.
  function setNativeValue(el, value) {
    return new Promise((resolve, reject) => {
      try {
        el.focus?.();
        const proto =
          el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : el.tagName === "SELECT"
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) {
          setter.call(el, value);
        } else {
          el.value = value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  // ---- text --------------------------------------------------------------

  function text() {
    // Mask password fields.
    const cloneSrc = document.body.cloneNode(true);
    cloneSrc.querySelectorAll("input[type=password]").forEach((i) => (i.value = "••••••"));
    // Mask long digit runs that look like card numbers.
    const txt = (cloneSrc.innerText || "").replace(/\b\d{12,19}\b/g, "••••••");
    return { text: truncate(txt, 20000), url: location.href };
  }

  // ---- screenshot --------------------------------------------------------

  async function screenshot() {
    // Content scripts can't take screenshots directly; ask background.
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "capture_visible_tab" }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.dataUrl) {
          reject(new Error(chrome.runtime.lastError?.message || "capture failed"));
        } else {
          resolve({ image: resp.dataUrl.split(",", 2)[1], mimeType: "image/png" });
        }
      });
    });
  }

  // ---- scroll ------------------------------------------------------------

  function scroll(args) {
    if (typeof args.pixels === "number") {
      window.scrollBy(0, args.pixels);
    } else if (args.direction) {
      const dh = window.innerHeight * 0.9;
      switch (args.direction) {
        case "down": window.scrollBy(0, dh); break;
        case "up": window.scrollBy(0, -dh); break;
        case "top": window.scrollTo(0, 0); break;
        case "bottom": window.scrollTo(0, document.body.scrollHeight); break;
      }
    } else {
      throw new Error("scroll needs `direction` or `pixels`");
    }
    return { scrollY: window.scrollY, scrollX: window.scrollX };
  }

  // ---- wait_for ----------------------------------------------------------

  function waitFor(args) {
    const timeoutMs = args.timeoutMs ?? 30000;
    const start = Date.now();
    return new Promise((resolve, reject) => {
      let done = false;
      const onLoad = () => {
        if (args.nav) {
          finish(resolve, {
            matched: true,
            nav: true,
            url: location.href,
            readyState: document.readyState,
          });
        }
      };
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        window.removeEventListener("load", onLoad, true);
        fn(value);
      };
      if (args.nav) {
        if (document.readyState === "complete") {
          return finish(resolve, {
            matched: true,
            nav: true,
            url: location.href,
            readyState: document.readyState,
          });
        }
        window.addEventListener("load", onLoad, true);
      }
      const tick = () => {
        if (done) return;
        if (args.selector) {
          if (document.querySelector(args.selector)) {
            return finish(resolve, { matched: true, selector: args.selector });
          }
        }
        if (args.text) {
          if ((document.body.innerText || "").includes(args.text)) {
            return finish(resolve, { matched: true, text: args.text });
          }
        }
        if (Date.now() - start > timeoutMs) {
          return finish(reject, new Error(`wait_for timed out after ${timeoutMs}ms`));
        }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  // ---- page_eval (high-risk) ---------------------------------------------

  async function runEval(args) {
    const code = args.code;
    if (typeof code !== "string" || !code.trim()) {
      throw new Error("page_eval needs non-empty `code`");
    }
    // Global kill switch: if the user disabled page_eval in settings, refuse
    // before any code runs (and before any confirmation prompt).
    const evalEnabled = await getSetting("pageEvalEnabled");
    if (evalEnabled === false) {
      throw new Error("page_eval disabled in settings");
    }
    // Confirm with the user via an enlarged Toast showing the full code.
    // Reuses lastConfirmed so same-origin eval within 60s of a prior approval
    // does not re-prompt. NOTE: this grace window is riskier for eval than
    // for click (see ADR-0008) — two evals can be totally unrelated code.
    await confirmWithEvalToast(code);
    // Execute. Wrap as an async IIFE in the global scope so the code can use
    // await/return and see page globals. `new Function` (not eval) gives us
    // global scope regardless of the strict-mode closure this file runs in.
    let result;
    try {
      const fn = new Function(
        '"use strict";\n' +
        'return (async () => {\n' + code + '\n})();'
      );
      result = await fn();
    } catch (e) {
      // Surface JS errors to the model as structured data, not a throw, so
      // the model can react (e.g. fix the code and retry).
      return {
        __evalError: true,
        name: e?.name || "Error",
        message: String(e?.message || e),
        stack: truncate(String(e?.stack || ""), 2000),
      };
    }
    const serialized = serializeResult(result);
    const mask = await getMaskSetting();
    return mask ? maskSensitive(serialized) : serialized;
  }

  // Safe serialization: handles cycles, DOM nodes, errors, exotic types, and
  // truncates very large payloads. Returns JSON-serializable data.
  function serializeResult(value, seen = new WeakSet(), depth = 0) {
    if (depth > 50) return "[depth limit]";
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "string") return truncate(value, 10000);
    if (t === "number" || t === "boolean") return value;
    if (t === "bigint") return `[BigInt:${value.toString()}]`;
    if (t === "symbol") return `[Symbol:${value.toString()}]`;
    if (t === "function") return `[function:${value.name || "anonymous"}]`;
    if (t === "object") {
      // Error → structured
      if (value instanceof Error) {
        return { __error: true, name: value.name, message: value.message };
      }
      // DOM node → short tag descriptor
      if (value instanceof Element) {
        const id = value.id ? `#${value.id}` : "";
        return `<${value.tagName.toLowerCase()}${id}>`;
      }
      if (value instanceof Node) {
        return `<${value.nodeName}>`;
      }
      // Cycle guard
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          if (value.length > 1000) return `[Array length=${value.length}, truncated]`;
          return value.slice(0, 1000).map((v) => serializeResult(v, seen, depth + 1));
        }
        // Plain object: enumerate own keys. Map/Set/Date get special tags.
        if (value instanceof Map) {
          const obj = {};
          let i = 0;
          for (const [k, v] of value) { obj[String(k)] = serializeResult(v, seen, depth + 1); if (++i > 1000) break; }
          return { __Map: obj };
        }
        if (value instanceof Set) {
          return { __Set: Array.from(value).slice(0, 1000).map((v) => serializeResult(v, seen, depth + 1)) };
        }
        if (value instanceof Date) return { __Date: value.toISOString() };
        if (value instanceof RegExp) return { __RegExp: value.toString() };
        const out = {};
        let count = 0;
        for (const key of Object.keys(value)) {
          if (count++ > 1000) { out.__truncated = true; break; }
          out[key] = serializeResult(value[key], seen, depth + 1);
        }
        return out;
      } finally {
        seen.delete(value);
      }
    }
    return String(value);
  }

  // Mask sensitive-looking values. Recursive. See ADR-0008 for the pattern
  // catalogue. Designed to stop tokens/cookies/secrets from reaching the AI
  // context (and logs) — at the cost of occasionally masking benign data.
  function maskSensitive(value) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "string") return maskString(value);
    if (t === "number") return maskNumber(value);
    if (t === "boolean") return value;
    if (Array.isArray(value)) return value.map(maskSensitive);
    if (t === "object") {
      const out = {};
      for (const k of Object.keys(value)) {
        out[maskKeyName(k)] = maskSensitive(value[k]);
      }
      return out;
    }
    return value;
  }

  const SENSITIVE_KEY = /(token|cookie|password|passwd|secret|api[_-]?key|auth|cred|session)/i;

  function maskKeyName(key) {
    return SENSITIVE_KEY.test(key) ? "••••" + key.slice(-2) : key;
  }

  function maskString(s) {
    if (s.length < 8) return s;
    let out = s;
    // JWT (eyJ... . ... . ...)
    out = out.replace(/ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "••••[jwt]");
    // Long hex (>=32): secrets, hashes, API keys
    out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, "••••[hex]");
    // Long digit runs (>=12): card numbers, account ids
    out = out.replace(/\b\d{12,}\b/g, "••••[num]");
    // Bearer / key-like patterns
    out = out.replace(/(?:bearer|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "••••[redacted]");
    // If the whole string looks like a credential, mask fully
    if (SENSITIVE_KEY.test(s) && s.length >= 8 && !/\s/.test(s)) {
      return "••••[sensitive]";
    }
    return out;
  }

  function maskNumber(n) {
    // Long integers (>=12 digits): card-like, big ids
    if (Number.isInteger(n) && Math.abs(n) >= 1e11) return "••••[num]";
    return n;
  }

  // Read the mask toggle from storage. Default true (mask on).
  let _maskCache = true;
  let _maskLoaded = false;
  function getMaskSetting() {
    if (_maskLoaded) return Promise.resolve(_maskCache);
    return new Promise((resolve) => {
      chrome.storage.local.get("evalMask", (r) => {
        // undefined → default true (mask on)
        _maskCache = r.evalMask !== false;
        _maskLoaded = true;
        resolve(_maskCache);
      });
    });
  }

  // Default values for the configurable settings managed by the options page.
  // KEEP IN SYNC with options.js DEFAULTS and background.js DEFAULTS. The
  // content script only consumes the subset relevant to in-page behavior.
  const DEFAULTS = {
    pageEvalEnabled: true,
    confirmHighRiskClick: true,
    confirmGraceMs: 60000,
    clickToastTimeoutMs: 30000,
    evalToastTimeoutMs: 45000,
  };

  // Read a single setting with its default. Not cached (these are read once
  // per action, and storage reads are cheap + async).
  function getSetting(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (r) => {
        const v = r[key];
        resolve(v === undefined ? DEFAULTS[key] : v);
      });
    });
  }

  // ---- storage_get (page localStorage / sessionStorage) -------------------
  //
  // Read-only access to the PAGE's Web Storage (not chrome.storage). Must run
  // in the content script (page context, same-origin). Frameworks like
  // Auth0/NextAuth/Firebase store tokens here. Values are ALWAYS masked
  // (independent of the eval mask toggle) because storage reads are silent
  // and a leaked token here is just as bad as in eval output. See ADR-0010.
  function storageGet(args) {
    const type = args.type === "session" ? "session" : "local";
    const key = args.key;
    let store;
    try {
      store = type === "session" ? window.sessionStorage : window.localStorage;
    } catch (e) {
      throw new Error(`storage unavailable: ${e.message}`);
    }
    if (key !== undefined && key !== null && key !== "") {
      const raw = store.getItem(key);
      if (raw === null) return { key, found: false };
      return { key, found: true, value: maskString(raw) };
    }
    // No key → dump all entries (masked). Cap to avoid huge payloads.
    const entries = {};
    let count = 0;
    const MAX = 500;
    for (let i = 0; i < store.length && count < MAX; i++) {
      const k = store.key(i);
      if (k === null) continue;
      try {
        entries[k] = maskString(store.getItem(k) || "");
      } catch (e) {
        entries[k] = "[unreadable]";
      }
      count++;
    }
    const truncated = store.length > MAX;
    return { type, entries, count, truncated, totalKeys: store.length };
  }

  // ---- Toast confirmation UI --------------------------------------------

  // Short-circuit window: a 60s window during which the same kind of
  // high-risk action on the same origin doesn't re-prompt.
  let lastConfirmed = { key: null, until: 0 };

  async function confirmWithToast(question, actionDesc) {
    const key = `${location.origin}:${actionDesc}`;
    const graceMs = await getSetting("confirmGraceMs");
    if (graceMs > 0 && lastConfirmed.key === key && Date.now() < lastConfirmed.until) {
      return; // within the grace window
    }
    const approved = await showToast(question);
    if (!approved) throw new Error(`user denied: ${actionDesc}`);
    lastConfirmed = { key, until: Date.now() + graceMs };
  }

  // Eval confirmation: enlarged Toast with the full code shown. Shares the
  // same lastConfirmed grace window as click/etc. The key is `origin:eval`.
  // Risk note (ADR-0008): within the 60s window, ANY new eval code on the
  // same origin runs silently — accept this because eval is not meant for
  // high-frequency use.
  async function confirmWithEvalToast(code) {
    const key = `${location.origin}:eval`;
    const graceMs = await getSetting("confirmGraceMs");
    if (graceMs > 0 && lastConfirmed.key === key && Date.now() < lastConfirmed.until) {
      return; // within grace window
    }
    const approved = await showEvalToast(code, location.href, document.title);
    if (!approved) throw new Error("user denied page_eval");
    lastConfirmed = { key, until: Date.now() + graceMs };
  }

  function describeForToast(el) {
    return truncate(nameOf(el) || roleOf(el) || el.tagName.toLowerCase(), 40);
  }

  function describeAction(el, kind) {
    const role = roleOf(el);
    if (kind === "click") {
      if (role === "link" || el.tagName === "A") return "navigate";
      if (role === "button") return "submit";
      return "click";
    }
    return kind;
  }

  function showToast(question) {
    return new Promise((resolve) => {
      const host = ensureToastHost();
      const card = document.createElement("div");
      card.className = "zcb-toast-card";
      card.innerHTML = `
        <div class="zcb-toast-title">Browser Bridge</div>
        <div class="zcb-toast-q"></div>
        <div class="zcb-toast-actions">
          <button class="zcb-toast-deny">Deny</button>
          <button class="zcb-toast-allow">Allow</button>
        </div>`;
      card.querySelector(".zcb-toast-q").textContent = question;
      host.appendChild(card);

      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        card.classList.add("zcb-toast-out");
        setTimeout(() => card.remove(), 150);
        resolve(val);
      };
      card.querySelector(".zcb-toast-allow").onclick = () => finish(true);
      card.querySelector(".zcb-toast-deny").onclick = () => finish(false);
      // Auto-deny so the tool call doesn't hang forever. Timeout is
      // configurable via settings (default 30s).
      getSetting("clickToastTimeoutMs").then((ms) => setTimeout(() => finish(false), ms));
    });
  }

  // Enlarged, warning-styled Toast for page_eval. Shows the full code in a
  // scrollable <pre>, plus the target URL and tab title so the user knows
  // exactly what runs where.
  function showEvalToast(code, url, tabTitle) {
    return new Promise((resolve) => {
      const host = ensureToastHost();
      const card = document.createElement("div");
      card.className = "zcb-toast-card zcb-eval-card";
      card.innerHTML = `
        <div class="zcb-eval-title">⚠ Browser Bridge: 执行确认</div>
        <div class="zcb-eval-meta"></div>
        <pre class="zcb-eval-code"></pre>
        <div class="zcb-eval-warn">上面的代码将在该页面以你的身份运行,可能读取 token / Cookie / 发起请求。</div>
        <div class="zcb-toast-actions">
          <button class="zcb-toast-deny">拒绝</button>
          <button class="zcb-toast-allow">允许执行</button>
        </div>`;
      // Use textContent for any value to prevent injection from code strings.
      card.querySelector(".zcb-eval-meta").textContent =
        `${truncate(url || "", 60)} · 「${truncate(tabTitle || "无标题", 40)}」`;
      card.querySelector(".zcb-eval-code").textContent = code;
      host.appendChild(card);

      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        card.classList.add("zcb-toast-out");
        setTimeout(() => card.remove(), 150);
        resolve(val);
      };
      card.querySelector(".zcb-toast-allow").onclick = () => finish(true);
      card.querySelector(".zcb-toast-deny").onclick = () => finish(false);
      // Esc key also denies, for keyboard users.
      const onKey = (e) => { if (e.key === "Escape") { finish(false); } };
      card.addEventListener("keydown", onKey);
      // Auto-deny (longer than click's — user needs time to read code).
      // Timeout is configurable via settings (default 45s).
      getSetting("evalToastTimeoutMs").then((ms) => setTimeout(() => { finish(false); }, ms));
    });
  }

  // Informational toast (blue) for non-high-risk notices, e.g. "debugger is
  // about to attach, infobar will flash briefly." Unlike the eval/click
  // toasts this defaults to PROCEED (resolve true) after a timeout — the
  // user must actively press Cancel to abort.
  function showInfoToast(message) {
    return new Promise((resolve) => {
      const host = ensureToastHost();
      const card = document.createElement("div");
      card.className = "zcb-toast-card zcb-info-card";
      card.innerHTML = `
        <div class="zcb-info-title">Browser Bridge</div>
        <div class="zcb-info-text"></div>
        <div class="zcb-info-actions">
          <button class="zcb-info-cancel">取消</button>
        </div>`;
      card.querySelector(".zcb-info-text").textContent = message;
      host.appendChild(card);

      let done = false;
      const finish = (proceed) => {
        if (done) return;
        done = true;
        card.classList.add("zcb-toast-out");
        setTimeout(() => card.remove(), 150);
        resolve(proceed);
      };
      card.querySelector(".zcb-info-cancel").onclick = () => finish(false);
      // Auto-proceed after 8s (informational, not a confirmation gate).
      setTimeout(() => finish(true), 8000);
    });
  }

  function ensureToastHost() {
    let host = document.getElementById("__zcb_toast_host");
    if (!host) {
      host = document.createElement("div");
      host.id = "__zcb_toast_host";
      // Inline critical styles so it shows even if toast.css didn't load.
      host.style.cssText =
        "position:fixed;top:16px;right:16px;z-index:2147483647;" +
        "display:flex;flex-direction:column;gap:8px;pointer-events:none;";
      (document.body || document.documentElement).appendChild(host);
    }
    return host;
  }
})();
