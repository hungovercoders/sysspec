export interface Scenario {
  name: string;
  gherkin: string;
  /** For a scenario inside a Rule: the Rule line, its description and
   * its Background - context the scenario needs, like the file header. */
  rule?: string;
}

// Every Gherkin keyword that opens a scenario (Example is the Gherkin 6
// synonym for Scenario, Scenario Template the synonym for the outline).
const SCENARIO_KEYWORDS = ["Scenario:", "Scenario Outline:", "Scenario Template:", "Example:"];

/** Split a .feature file into (header, scenarios). The header is
 * everything before the first Rule or scenario — Feature line,
 * description and the Feature-level Background. A scenario inside a Rule
 * also carries that Rule's own block (line, description, Background) as
 * `rule`, so any one scenario stands alone with header + rule + body.
 */
export function splitGherkin(text: string): { header: string; scenarios: Scenario[] } {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let headerEnd = lines.length;
  const spans: { name: string; start: number; end: number; rule: string | undefined }[] = [];
  // The Rule currently open: where its block starts, and where it ends
  // (at its first scenario) once known.
  let rule: { start: number; end: number | null } | null = null;
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
  const closeRunning = (at: number) => {
    const last = spans[spans.length - 1];
    if (last) last.end = Math.min(last.end, at);
  };
  const text_ = (from: number, to: number) => lines.slice(from, to).join("").replace(/\n+$/, "");
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (SCENARIO_KEYWORDS.some((k) => stripped.startsWith(k))) {
      const start = blockStart(i);
      headerEnd = Math.min(headerEnd, start);
      closeRunning(start);
      if (rule && rule.end === null) rule.end = start;
      const name = stripped.slice(stripped.indexOf(":") + 1).trim();
      spans.push({
        name,
        start,
        end: lines.length,
        rule: rule ? text_(rule.start, rule.end!) : undefined,
      });
    } else if (stripped.startsWith("Rule:")) {
      const start = blockStart(i);
      headerEnd = Math.min(headerEnd, start);
      closeRunning(start);
      rule = { start, end: null };
    } else if (stripped.startsWith("Background:")) {
      // A Background after a scenario (a Rule's, misplaced) still closes
      // the running scenario; one before any scenario is header or rule.
      if (!rule || rule.end !== null) closeRunning(blockStart(i));
    }
  }
  return {
    header: text_(0, headerEnd),
    scenarios: spans.map((s) => {
      const out: Scenario = { name: s.name, gherkin: text_(s.start, s.end) };
      if (s.rule !== undefined) out.rule = s.rule;
      return out;
    }),
  };
}
