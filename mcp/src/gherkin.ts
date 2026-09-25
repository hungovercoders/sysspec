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

const STEP_RE = /^(Given|When|Then|And|But|\*)(\s|$)/;

/** Which lines are inside a step's docstring (the fences included). A
 * fence (""" or ```) opens a docstring only straight after a step line -
 * a fence in a Feature or Rule description is prose - and only when it
 * is closed later; an unclosed fence hides nothing. Inside a docstring a
 * line is data: "Rule: x" there must not cut the running scenario. */
function docstringLines(lines: string[]): boolean[] {
  const data = lines.map(() => false);
  let lastStep = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    const fence = stripped.startsWith('"""') ? '"""' : stripped.startsWith("```") ? "```" : null;
    if (fence && lastStep) {
      const close = lines.findIndex((l, j) => j > i && l.trim().startsWith(fence));
      if (close !== -1) {
        for (let j = i; j <= close; j++) data[j] = true;
        i = close;
        lastStep = false;
        continue;
      }
    }
    if (stripped && !stripped.startsWith("#")) lastStep = STEP_RE.test(stripped);
  }
  return data;
}

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
  const data = docstringLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (data[i]) continue;
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
