/** Substitute {{target}}/{{chain}} into already-parsed JSON, string values only — so a free-form
 *  target containing quotes/braces can never break or mutate the requirements structure. */
export function substitutePlaceholders(value: unknown, target: string, chain: string): unknown {
  if (typeof value === 'string') return value.split('{{target}}').join(target).split('{{chain}}').join(chain);
  if (Array.isArray(value)) return value.map((v) => substitutePlaceholders(v, target, chain));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitutePlaceholders(v, target, chain);
    return out;
  }
  return value;
}
