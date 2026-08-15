// The toast is the extension's own UI living in the page's DOM, so the moment it
// resolves is a contract: page_snapshot_precise awaits this promise and then
// reads the accessibility tree. While `finish` resolved before removing the card,
// that read landed inside the 150ms exit animation and picked up the toast's own
// Cancel button as a page control — on a page with no interactive elements at
// all, precise returned refCount:1 (#132).
//
// So what is pinned here is ordering, not markup: by the time the promise
// settles, the card must already be out of the document.

import { describe, expect, test } from "bun:test";
import { showInfoToast } from "./toast";

// Minimal stand-in for the handful of DOM operations showInfoToast performs.
// The suite has no jsdom/happy-dom; fakes stay hand-rolled (see canvas-note.test.ts).
class FakeElement {
  className = "";
  id = "";
  textContent = "";
  innerHTML = "";
  style = { cssText: "" };
  classes: string[] = [];
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  onclick: (() => void) | null = null;
  onAppend: ((child: FakeElement) => void) | null = null;
  private stubs = new Map<string, FakeElement>();

  classList = {
    add: (c: string) => {
      this.classes.push(c);
    },
  };

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    this.onAppend?.(child);
  }

  // innerHTML is assigned as a template, then queried by class. Hand back a
  // stable stub per selector so the caller's textContent/onclick writes stick.
  querySelector(selector: string): FakeElement {
    let stub = this.stubs.get(selector);
    if (!stub) {
      stub = new FakeElement();
      this.stubs.set(selector, stub);
    }
    return stub;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

function installFakeDom() {
  const body = new FakeElement();
  const byId = new Map<string, FakeElement>();
  body.onAppend = (el) => {
    // ensureToastHost sets .id before appending, so registering here is enough
    // for a second call to find the existing host instead of duplicating it.
    if (el.id) byId.set(el.id, el);
  };
  (globalThis as Record<string, unknown>).document = {
    body,
    documentElement: body,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => new FakeElement(),
  };
  return { body };
}

function toastHost(body: FakeElement) {
  return body.children[0];
}

describe("showInfoToast", () => {
  test("the card is out of the DOM before the promise resolves", async () => {
    const { body } = installFakeDom();

    const pending = showInfoToast({ message: "attaching the debugger", cancel: "Cancel" });

    const host = toastHost(body);
    expect(host.children).toHaveLength(1); // the toast is up while we wait

    // Cancel rather than waiting out the 8s auto-proceed.
    host.children[0].querySelector(".zcb-info-cancel").onclick!();

    const proceed = await pending;

    expect(proceed).toBe(false);
    // The regression: this was 1, because removal was still 150ms away.
    expect(host.children).toHaveLength(0);
  });

  // The auto-proceed branch is deliberately not covered: it would cost the suite
  // the toast's full 8s timeout, and it reaches the same `finish` the tests here
  // already pin — so it would buy one extra assertion at ~10x the suite runtime.
  test("cancelling twice resolves once and leaves nothing behind", async () => {
    const { body } = installFakeDom();

    const pending = showInfoToast({ message: "attaching", cancel: "Cancel" });
    const host = toastHost(body);
    const cancel = host.children[0].querySelector(".zcb-info-cancel");

    cancel.onclick!();
    cancel.onclick!();

    expect(await pending).toBe(false);
    expect(host.children).toHaveLength(0);
  });
});
