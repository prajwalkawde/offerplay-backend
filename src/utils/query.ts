/** Extract a single string from Express query params (string | string[] | ParsedQs | ...) */
export function qs(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return qs(val[0]);
  return undefined;
}
