export interface Bounded {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

/** Cap text at maxBytes on a line boundary, counting UTF-8 bytes. */
export function bounded(text: string, maxBytes: number): Bounded {
  const raw = new TextEncoder().encode(text);
  const total = raw.length;
  if (total <= maxBytes) {
    return { text, truncated: false, totalBytes: total };
  }
  // A cut mid-sequence leaves replacement chars only at the tail;
  // dropping them trims the partial trailing character.
  let cut = new TextDecoder("utf-8", { fatal: false })
    .decode(raw.slice(0, maxBytes))
    .replace(/�+$/, "");
  const nl = cut.lastIndexOf("\n");
  if (nl !== -1) cut = cut.slice(0, nl);
  return { text: cut, truncated: true, totalBytes: total };
}
