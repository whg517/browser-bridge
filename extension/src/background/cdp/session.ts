// CdpSession — a thin Facade over chrome.debugger (CDP) for ONE tab.
//
// The promisified attach/detach/send primitives (and the NON_DEBUGGABLE /
// isDebuggable URL filter) were previously private to background/precise.ts.
// They live here now so both precise.ts and the CDP page backend share one
// implementation (see ADR-0017). `evaluate` runs code in the page's MAIN world
// via Runtime.evaluate — this is what lets CDP mode bypass page CSP.

// The subset of the CDP payloads we read (not the full protocol).
interface RemoteObject {
  type?: string;
  className?: string;
  description?: string;
  value?: unknown;
}
interface ExceptionDetails {
  text?: string;
  exception?: RemoteObject;
}
interface EvaluateResponse {
  result?: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}
interface CaptureScreenshotResponse {
  data?: string;
}

// URLs the debugger cannot attach to. Filter before calling attach.
export const NON_DEBUGGABLE = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^view-source:/i,
  /^about:/i,
  /^edge:\/\//i,
];

export function isDebuggable(url: string | undefined): boolean {
  if (!url) return false;
  return !NON_DEBUGGABLE.some((re) => re.test(url));
}

// Promisified chrome.debugger primitives. Exported so precise.ts reuses them.
export function dbgAttach(tabId: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export function dbgDetach(tabId: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // detach must never throw — used in finally / teardown. Swallow errors.
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

export function dbgSend<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result as T);
    });
  });
}

// Build a Runtime.evaluate expression that invokes a page function with args.
// The function is stringified and applied to the JSON-serialized args, so it
// runs self-contained in the page — it must NOT close over module scope.
export function buildEvaluateExpression(
  fn: (...args: never[]) => unknown,
  args: readonly unknown[] = []
): string {
  return `(${fn.toString()}).apply(undefined, ${JSON.stringify(args)})`;
}

// Turn a CDP exceptionDetails into a single-line error message.
export function evalExceptionMessage(details: ExceptionDetails): string {
  const desc = details.exception?.description;
  if (desc) return desc.split("\n")[0];
  return details.text || "evaluation failed";
}

export class CdpSession {
  readonly tabId: number;
  private attached = false;
  private attaching: Promise<void> | null = null;

  constructor(tabId: number) {
    this.tabId = tabId;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  // Attach the debugger to this tab. Idempotent: a no-op if already attached.
  // The banner ("Started debugging this browser") stays up until detach — by
  // design in CDP mode (ADR-0017), the registry keeps sessions attached.
  async attach(): Promise<void> {
    if (this.attached) return;
    // Dedupe concurrent attaches. Without this, two page ops racing on a fresh
    // tab each issue chrome.debugger.attach; the second fails ("another debugger
    // is already attached"), and the caller's cleanup deletes the session the
    // first successfully attached — orphaning the debugger (stuck banner, CDP
    // broken for that tab). Share one in-flight attach instead.
    if (!this.attaching) {
      this.attaching = this.doAttach().finally(() => {
        this.attaching = null;
      });
    }
    return this.attaching;
  }

  private async doAttach(): Promise<void> {
    try {
      await dbgAttach(this.tabId);
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (/another debugger/i.test(msg)) {
        throw new Error("该标签页已打开 DevTools,CDP 模式无法附加。请关闭 DevTools 后重试。", {
          cause: e,
        });
      }
      throw e;
    }
    this.attached = true;
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;
    await dbgDetach(this.tabId);
  }

  // Mark the session as detached WITHOUT calling chrome.debugger.detach — for
  // the case where Chrome already detached us (onDetach event).
  markDetached(): void {
    this.attached = false;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return dbgSend<T>(this.tabId, method, params);
  }

  // Evaluate a page function (or raw expression) in the page's MAIN world.
  // returnByValue serializes the result to JSON. `awaitPromise` resolves a
  // returned promise before serializing (needed for wait_for / toasts).
  // Throws on an uncaught page exception.
  async evaluate<T = unknown>(
    fnOrExpr: string | ((...args: never[]) => unknown),
    args: readonly unknown[] = [],
    opts: { awaitPromise?: boolean } = {}
  ): Promise<T> {
    const expression =
      typeof fnOrExpr === "function" ? buildEvaluateExpression(fnOrExpr, args) : fnOrExpr;
    const res = await this.send<EvaluateResponse>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise ?? false,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(evalExceptionMessage(res.exceptionDetails));
    }
    return res.result?.value as T;
  }

  // Runtime.evaluate that returns the raw response (result + exceptionDetails)
  // so callers can map a page exception to structured data (page_eval).
  rawEvaluate(
    expression: string,
    opts: { awaitPromise?: boolean } = {}
  ): Promise<EvaluateResponse> {
    return this.send<EvaluateResponse>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise ?? false,
      userGesture: true,
    });
  }

  // Screenshot the viewport via CDP (preferred over a page-fn). Returns the
  // base64 PNG payload without the data: URL prefix, matching the content path.
  async screenshot(): Promise<{ image: string; mimeType: string }> {
    const res = await this.send<CaptureScreenshotResponse>("Page.captureScreenshot", {
      format: "png",
    });
    return { image: res.data ?? "", mimeType: "image/png" };
  }
}

export type { EvaluateResponse, ExceptionDetails };
