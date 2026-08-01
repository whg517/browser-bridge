// The isolated-world CSP block that stops page_eval in the content script.
//
// MV3 content scripts run in an isolated world governed by the EXTENSION's CSP,
// not the page's. Chrome's default extension policy is
//   script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' …
// — note 'wasm-unsafe-eval' but no 'unsafe-eval' — so `new Function` throws in
// the content script on EVERY page, for every user, regardless of what CSP (if
// any) the page itself sends. Verified against three pages differing only in
// their CSP, including one explicitly allowing 'unsafe-eval': all three blocked.
//
// The escape hatch is CDP mode (ADR-0017), which evaluates through
// chrome.debugger in the page's main world. Turning that on attaches a debugger
// and is the operator's call, not ours (ADR-0025) — so the failure is written
// to be relayed: the agent reads it and tells the user what to switch on.

export const CSP_EVAL_MESSAGE =
  "page_eval cannot run: Chrome forbids this extension from evaluating code in " +
  "the page, and that applies to every site (it is the extension's own policy, " +
  "not this page's). TELL THE USER, in your own words: to use page_eval they " +
  "need to open the Browser Bridge extension's Options page and turn on " +
  '"CDP mode", which runs page operations through Chrome\'s debugger instead — ' +
  'Chrome will then show a "debugging" bar while it\'s on. Do not retry until ' +
  "they confirm. If you only need to read or click the page, page_snapshot / " +
  "page_text / page_click / page_fill work without it.";

// Is this failure the CSP block, rather than a fault in the caller's code?
// Chrome raises EvalError; other engines only say so in the message.
export function isCspEvalBlock(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "EvalError") return true;
  return /content security policy/i.test(String(err?.message || ""));
}
