// GENERATED from contracts/tools.json by scripts/gen-ops.mjs — DO NOT EDIT.
// Edit the contract, then run `make gen` (or `node scripts/gen-ops.mjs`).
//
// The tool catalogue, JS side: op names + Chinese UI labels for the options
// page. tools.rs is verified against the same contract in `cargo test`.

export interface ToolInfo {
  op: string;
  desc: string;
}

export const TOOLS: ToolInfo[] = [
  { op: "tab_list", desc: "列出所有标签页" },
  { op: "tab_focus", desc: "切换到指定标签页" },
  { op: "tab_open", desc: "打开新标签页(需白名单)" },
  { op: "tab_close", desc: "关闭标签页(带确认)" },
  { op: "page_snapshot", desc: "快照页面可交互元素" },
  { op: "page_click", desc: "点击元素" },
  { op: "page_fill", desc: "填写表单字段" },
  { op: "page_text", desc: "读取页面可见文本" },
  { op: "page_screenshot", desc: "截取可视区域" },
  { op: "page_scroll", desc: "滚动页面" },
  { op: "page_wait_for", desc: "等待条件满足" },
  { op: "page_eval", desc: "执行任意 JS(高危)" },
  { op: "page_snapshot_precise", desc: "精确快照(走 debugger)" },
  { op: "cookie_get", desc: "读取 Cookie(脱敏)" },
  { op: "storage_get", desc: "读取 localStorage/sessionStorage(脱敏)" },
];

// All op names, for enumeration / consistency checks.
export const OP_NAMES: string[] = TOOLS.map((t) => t.op);
