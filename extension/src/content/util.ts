// Small shared helpers for the content-script modules.

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * If this document draws its content to a canvas, describe it — otherwise null.
 *
 * Some sites render text into a <canvas> specifically so it cannot be scraped
 * (zhipin.com does this for résumés). Every text-based tool then returns nothing
 * for that region, correctly: there are no text nodes to read. Without a hint,
 * an agent sees an empty or suspiciously short result, follows the usual advice
 * — wait and re-snapshot, then try the precise backend — and gets nothing twice
 * more, because neither can help. It then concludes the page is empty.
 *
 * Naming the cause turns two wasted calls and a wrong conclusion into one
 * screenshot. The size floor keeps icons, sparklines and chart widgets from
 * triggering it; only a canvas large enough to BE the content counts.
 */
export function canvasContentNote(): string | null {
  const big = Array.from(document.querySelectorAll("canvas")).find(
    (c) => c.width * c.height >= 250_000
  );
  if (!big) return null;
  return (
    `Part of this page is drawn into a <canvas> (${big.width}x${big.height}px) — some sites ` +
    "render text that way to prevent scraping, and no text-based tool can read it. " +
    "If the content you expected is missing, use page_screenshot and read the image."
  );
}
