export interface Scenario {
  name: string;
  gherkin: string;
}

// Every Gherkin keyword that opens a scenario (Example is the Gherkin 6
// synonym for Scenario, Scenario Template the synonym for the outline).
const SCENARIO_KEYWORDS = ["Scenario:", "Scenario Outline:", "Scenario Template:", "Example:"];
// Keywords that close the running scenario without opening one: a Rule
// groups the scenarios after it, and a Rule may carry its own Background.
const BOUNDARY_KEYWORDS = ["Rule:", "Background:"];

/** Split a .feature file into (header, scenarios). The header is
 * everything before the first scenario — Feature line, description and
 * Background — which a scenario needs to stand alone.
 */
export function splitGherkin(text: string): { header: string; scenarios: Scenario[] } {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let headerEnd = lines.length;
  const spans: { name: string; start: number; end: number }[] = [];
  // Where a keyword line's block starts: its tags and comments go with it.
  const blockStart = (i: number): number => {
    let start = i;
    while (start > 0) {
      const prev = lines[start - 1].trim();
      if (prev.startsWith("@") || prev.startsWith("#")) start -= 1;
      else break;
    }
    return start;
  };
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (SCENARIO_KEYWORDS.some((k) => stripped.startsWith(k))) {
      const start = blockStart(i);
      if (spans.length === 0) headerEnd = Math.min(headerEnd, start);
      else spans[spans.length - 1].end = Math.min(spans[spans.length - 1].end, start);
      const name = stripped.slice(stripped.indexOf(":") + 1).trim();
      spans.push({ name, start, end: lines.length });
    } else if (spans.length && BOUNDARY_KEYWORDS.some((k) => stripped.startsWith(k))) {
      spans[spans.length - 1].end = Math.min(spans[spans.length - 1].end, blockStart(i));
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
