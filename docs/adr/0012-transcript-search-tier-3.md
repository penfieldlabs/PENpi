# 12. Tier-3 transcript search tool

- Status: Accepted
- Date: 2026-06-21

## Context

The three-tier model ([0004](0004-three-tier-memory.md)) promises the session transcript
as a searchable safety net, and the injected behavioral protocol told the model to
"search the session transcript files." But no such tool existed — the agent had only
generic `bash`/`read` and would flail (it doesn't know pi's cwd→dir encoding). Tier 3 was
a hollow promise (tracked as GitHub issue #2).

## Decision

Ship a `search_transcript` Pi tool backed by a pure, read-only `searchTranscripts()` over
`<agentDir>/sessions/<encoded-cwd>/*.jsonl` (replicating pi's exact cwd encoding). It
extracts role+text from message/custom/tool/bash entries, matches case-insensitively,
newest-file-first, with a limit. It never writes or deletes logs. The protocol now points
the agent at this tool.

## Consequences

- Tier 3 is real and reachable; the protocol's promise is now true.
- Searches the current project's sessions; cross-project/global search is a future option.
- Pure core function is unit-tested against fixtures (never real sessions).
