/** repr()-style formatting used by the tool error messages.
 *
 * The error messages are part of the served contract (the test suite
 * matches on them) and quote values and lists in repr() style — single
 * quotes, ['a', 'b'] lists. These helpers own that formatting.
 */

export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === "\\" || ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + quote;
}

/** A list of strings quoted repr()-style: ['a', 'b']. */
export function pyList(items: string[]): string {
  return "[" + items.map(pyRepr).join(", ") + "]";
}

/** Sort strings by code point, locale-independently. */
export function pySorted(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
