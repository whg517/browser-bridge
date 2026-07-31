// Shared "AI Canvas artifact" markup — a mock job preview (BOSS-style), reused
// across every embedding mode so each renders identical, uniquely-labeled
// content. The label lets us tell which embedding a tool actually read.
(function () {
  const css = `
    .bb-card{font:14px/1.6 system-ui,sans-serif;border:1px solid #d0d7de;border-radius:8px;padding:12px;max-width:440px;background:#fff}
    .bb-card .pay{color:#c0392b;font-weight:600}
    .bb-card table{border-collapse:collapse;margin:6px 0}
    .bb-card td{border:1px solid #eee;padding:2px 8px}
    .bb-card .readout{font-family:ui-monospace,monospace;color:#036;margin-top:6px}
    .bb-card button{margin-top:6px}
  `;
  window.cardHTML = function (L) {
    return `<style>${css}</style>
    <div class="bb-card">
      <h2>高级前端工程师 <small>[${L}]</small></h2>
      <p class="pay">薪资:25-40K·14薪</p>
      <table>
        <tr><td>公司</td><td>示例科技有限公司</td></tr>
        <tr><td>城市</td><td>上海 · 浦东新区</td></tr>
        <tr><td>经验</td><td>3-5 年</td></tr>
      </table>
      <p class="jd">岗位职责:负责 Web 前端架构与性能优化。【CANVAS-BODY::${L}】</p>
      <a href="mailto:hr-${L}@example.com">投递邮箱(${L})</a>
      <button class="apply" onclick="this.textContent='已投递 ✓ [${L}]'">立即投递 (${L})</button>
      <input class="note" aria-label="备注 ${L}" placeholder="给HR留言" />
      <div class="readout">状态:未投递 [${L}]</div>
    </div>`;
  };
  // A full standalone document (for srcdoc / blob embedding).
  window.cardDoc = function (L) {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Canvas ${L}</title></head><body>${window.cardHTML(L)}</body></html>`;
  };
})();
