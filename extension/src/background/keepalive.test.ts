// The wake alarm is the only thing that can revive a terminated MV3 service
// worker: port.ts's reconnect timer dies with the worker, and native messaging
// is extension-initiated so the host cannot reach in. These tests pin the two
// properties that make it work — that an alarm is actually registered, and that
// firing it does not disturb a healthy port.

import { beforeEach, describe, expect, test } from "bun:test";

type AlarmInfo = { name: string };
type AlarmListener = (a: AlarmInfo) => void;

const created: Array<{
  name: string;
  opts: { periodInMinutes?: number; delayInMinutes?: number };
}> = [];
let listeners: AlarmListener[] = [];
let connectNativeCalls = 0;
let connected = false;

// Stand in for the extension APIs port.ts touches. Installed before the module
// under test is imported, since installKeepalive runs against the global.
function installChromeStub() {
  created.length = 0;
  listeners = [];
  connectNativeCalls = 0;
  connected = false;
  (globalThis as Record<string, unknown>).chrome = {
    alarms: {
      create: (name: string, opts: { periodInMinutes?: number; delayInMinutes?: number }) =>
        created.push({ name, opts }),
      onAlarm: { addListener: (fn: AlarmListener) => listeners.push(fn) },
    },
    runtime: {
      // A connectNative that "succeeds" without a real host.
      connectNative: () => {
        connectNativeCalls++;
        connected = true;
        return {
          onMessage: { addListener: () => {} },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {},
        };
      },
      getManifest: () => ({ version: "0.0.0" }),
      lastError: undefined,
    },
  };
  (globalThis as Record<string, unknown>).navigator = { userAgent: "Chrome/151.0.0.0" };
}

const fire = (name: string) => listeners.forEach((fn) => fn({ name }));

describe("service-worker wake alarm", () => {
  beforeEach(() => installChromeStub());

  // Two alarms, not one, as a hedge against Chrome delaying an alarm
  // arbitrarily (the documented behaviour) — NOT to work around a clamp on
  // periodInMinutes: 0.5, which does not exist since Chrome 120. See port.ts.
  test("registers two alarms half a cycle apart", async () => {
    const { installKeepalive } = await import("./port");
    installKeepalive();
    // Two alarms on a 1-minute period, offset by half of it, give a ~30s
    // nominal cadence. A single `periodInMinutes: 0.5` alarm would give the same
    // nominal cadence — the second alarm buys a second, independent draw against
    // Chrome's arbitrary alarm delay, not a shorter period.
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.opts.periodInMinutes)).toEqual([1, 1]);
    expect(created[1].opts.delayInMinutes).toBe(0.5);
    expect(new Set(created.map((c) => c.name)).size).toBe(2);
  });

  test("an unrelated alarm is ignored", async () => {
    const { installKeepalive } = await import("./port");
    installKeepalive();
    const before = connectNativeCalls;
    fire("some-other-extension-alarm");
    expect(connectNativeCalls).toBe(before);
  });

  test("firing while disconnected reconnects; firing while connected does not", async () => {
    const mod = await import("./port");
    mod.installKeepalive();

    // Disconnected: the alarm is the recovery path, so it must act.
    expect(mod.isNativeConnected()).toBe(false);
    fire("bb-reconnect");
    expect(connectNativeCalls).toBe(1);
    expect(mod.isNativeConnected()).toBe(true);

    // Connected: an open port already keeps the worker alive, and tearing it
    // down every 30s would drop the host process mid-session for no reason.
    fire("bb-reconnect");
    expect(connectNativeCalls).toBe(1);
    expect(connected).toBe(true);
  });
});
