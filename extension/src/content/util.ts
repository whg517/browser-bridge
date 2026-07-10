// Small shared helpers for the content-script modules.

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
