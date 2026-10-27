# Roadmap

Roadmap items are design direction, not release promises.

## Normalize provider-native web search

Status: research / planned — tracked in
[GitHub issue #9](https://github.com/penfieldlabs/PENpi/issues/9).

Some model providers expose web search as a native tool. PENpi should eventually make
that usable without assuming every endpoint for a model has the same capability.

Before implementation:

- Detect support from the active provider/endpoint capabilities, not a model-name list.
- Require explicit opt-in and show provider-specific billing and data-handling implications.
- Define a search policy such as `off`, `external-mcp`, `provider-native`, or deliberate
  `auto`; never silently add a paid tool.
- Present one clear search path to the model and avoid duplicate calls when external MCP
  and native search are both available.
- Preserve source URLs, citations, query provenance, and tool errors in transcripts.
- Degrade cleanly when search is unavailable; memory, the context engine, and transcript
  search must continue independently.
- Test direct providers and aggregators, session resume, provider handoff, rate limits,
  no-results behavior, and cost reporting.

Until that contract exists, provider-native search remains provider configuration and
external MCP search remains a user-selected option. See [WEB_SEARCH.md](WEB_SEARCH.md).

## Standing rules file

Status: idea — planned after 0.5.0; adoption decided by an evaluation (E5).

E4 (October 2026) showed that standing instructions are lost when a cut of the context
window removes the message that gave them (PENpi 0.4's FIFO): the model still answers
questions about the rules, but stops applying them while it works. 0.5.0 fixes this by
carrying the user's own messages across every cut. A rules file would add what that
cannot:

- It persists: rules carry into new sessions.
- It is visible: the user can open and edit it.
- It is compact: a short, distilled list instead of every message the user sent.

Proposed design:

- The first user prompt of every new session is saved automatically to `FIRST_PROMPT.md`.
- At session start, a one-line instruction tells the agent to create and maintain `RULES.md`
  with the user's standing instructions.
- After every cut of the context window, one line in the context engine's header reminds
  the agent that it has a rules file it must follow, and that it changes the file only
  when the user directs it.

Before implementation:

- First evaluate what Pi already has: it loads `AGENTS.md` and `CLAUDE.md` from the project
  into the system prompt, which survives every cut. E4 ran with `--no-context-files`, so it
  never tested them. A rules file may turn out to be `AGENTS.md` maintained at the user's
  direction.
- Decide whether the engine pastes the file's content after each cut or only reminds the
  agent that it exists. E4 found agents rarely look things up unprompted while working, so
  a reminder alone may not be enough; pasting costs about the same tokens as the 0.5.0
  message carry-over.
- Decide where the files live (session directory or project) and how they relate to the
  project instructions in `AGENTS.md`, which Pi already loads into every session.
- Guard against drift: the agent adds or changes rules only at the user's direction; the
  user can edit the file directly.
- Evaluate before adopting (E5, on the E4 harness): message carry-over alone, rules file
  with a reminder, rules file pasted, and carry-over plus rules file. Measure rule
  compliance, fact recall and cost per step.
- Keep the 0.5.0 message carry-over as the safety net unless E5 shows the rules file alone
  matches it.
- Cover the remaining gap: a rule the agent reads in a file mid-session is carried by
  neither the message carry-over nor the system prompt. The next E4 version plants one rule
  that way.
