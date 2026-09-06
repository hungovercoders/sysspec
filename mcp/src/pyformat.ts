/** Formatting helpers that reproduce Python's repr() in error messages.
 *
 * The tool error messages are part of the served contract (the test suite
 * matches on them), and they were authored with f-string {x!r} formatting.
 * These helpers keep the TypeScript port byte-compatible for the realistic
 * case (printable strings without exotic escapes).
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

/** Python's repr of a list of strings: ['a', 'b']. */
export function pyList(items: string[]): string {
  return "[" + items.map(pyRepr).join(", ") + "]";
}

/** Python's sorted() over strings (code-point order, like Python's <). */
export function pySorted(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
