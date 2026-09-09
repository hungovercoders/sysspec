---
title: Claude Code plugin & skills
description: The MCP tools plus three skills, installable in any Claude Code session.
---

The sysspec repo doubles as a Claude Code plugin: the MCP server plus three
skills are the installed surface. Four ways in, in order of preference.

**1. Install from the marketplace (no clone needed).** Inside any Claude
Code session:

```text
/plugin marketplace add hungovercoders/sysspec
/plugin install sysspec@hungovercoders
```

You get the MCP tools *and* the skills, available in every project. To pick
up a new version later: `/plugin marketplace update hungovercoders` then
reinstall (or `/reload-plugins` after an auto-update).

**2. Load a local clone as a plugin.** From any project directory:

```bash
claude --plugin-dir /path/to/sysspec
```

Same result, scoped to that session — useful when iterating on specs.

**3. Register just the MCP server** — tools only, no skills. See
[the MCP server page](/mcp/).

**4. Connect to a hosted URL** — tools only, no local process at all. Also
on [the MCP server page](/mcp/).

Whichever route, verify with `/mcp` and then `list_services()`.

## The three skills

The skills are written to be read as documentation and executed as agent
process: same steps, same commands, whether a human or an agent is driving.

| Skill | What it drives |
| --- | --- |
| [`sysspec`](https://github.com/hungovercoders/sysspec/blob/main/skills/sysspec/SKILL.md) | Working against specs: the gated/ungated distinction, the order of operations across the seven tools, implementing from Gherkin, and the full [conventions](/conventions/) list. |
| [`implement-service`](https://github.com/hungovercoders/sysspec/blob/main/skills/implement-service/SKILL.md) | Building the real thing: a new repo pinning a released `<service>/v<version>` tag in `contracts.lock`, verified end to end with `task contracts:verify`. |
| [`consume-service`](https://github.com/hungovercoders/sysspec/blob/main/skills/consume-service/SKILL.md) | Building a consumer — a UI, client, or downstream system — against the pinned mocks, before or without the real service existing. |

With the plugin installed, just ask — "implement orders", "build a UI
against payments" — and the matching skill drives the whole loop. See
[Implement or consume a service](/implement-and-consume/).
