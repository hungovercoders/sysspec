export interface Scenario {
  name: string;
  gherkin: string;
}

/** Split a .feature file into (header, scenarios). The header is
 * everything before the first scenario — Feature line, description and
 * Background — which a scenario needs to stand alone.
 */
export function splitGherkin(text: string): { header: string; scenarios: Scenario[] } {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let headerEnd = lines.length;
  const spans: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("Scenario:") || stripped.startsWith("Scenario Outline:")) {
      let start = i;
      while (start > 0) {
        const prev = lines[start - 1].trim();
        if (prev.startsWith("@") || prev.startsWith("#")) start -= 1;
        else break;
      }
      if (spans.length === 0) headerEnd = start;
      else spans[spans.length - 1].end = start;
      const name = stripped.slice(stripped.indexOf(":") + 1).trim();
      spans.push({ name, start, end: lines.length });
    }
  }
  const header = lines.slice(0, headerEnd).join("").replace(/\n+$/, "");
  return {
    header,
    scenarios: spans.map((s) => ({
      name: s.name,
      gherkin: lines.slice(s.start, s.end).join("").replace(/\n+$/, ""),
    })),
  };
}
