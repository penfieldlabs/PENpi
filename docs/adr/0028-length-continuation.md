# 28. Continue responses cut off at the output token limit

- Status: Accepted
- Date: 2026-10-11

## Context

When a model reaches its output token limit (`maxTokens`), the provider ends the response
with `stopReason: "length"`. Pi treats that like any finished response: the run settles
and waits for the user, often in the middle of a sentence, a code block, or a file being
written. Nothing in the transcript says the answer is incomplete, and the next user
message has to ask for the rest.

Pi's overflow recovery already handles one `"length"` case: a response with **zero output**
whose input fills at least 99% of the window (`isContextOverflow`, case 3) is a server that
truncated the input to fit, and pi compacts and continues on its own.

## Decision

PENpi's `agent_end` handler looks at the last assistant message of the loop. If it stopped
with `"length"` and produced output, PENpi calls
`pi.sendUserMessage(LENGTH_CONTINUATION_PROMPT, { deliverAs: "followUp" })`, asking the
model to continue exactly where it stopped without repeating itself.

- **`agent_end`, not `agent_settled`.** At `agent_end` the run is still active, so the
  message is queued rather than started as a new prompt. Pi's post-run handling turns a
  message queued by an `agent_end` handler into another turn of the same run, after its
  retry and compaction checks (`_handlePostAgentRun`). At `agent_settled` the run is
  already over.
- **At most 3 continuations per run** (`MAX_LENGTH_CONTINUATIONS`). A model that hits the
  limit every time would otherwise loop for as long as it keeps writing. Past the cap,
  PENpi stops and warns once. The count resets at `agent_settled`, so every new prompt gets
  its own budget.
- **Only with output > 0.** The zero-output case is pi's overflow recovery; a continuation
  on top of its compaction would be a second, unrequested turn.

## Consequences

- A long answer arrives in up to four parts within one run instead of stopping at the
  first limit. Each continuation is an ordinary user message in the transcript, so the
  history shows exactly what happened.
- Each continuation is a full request: the conversation is sent again. Its cost is that of
  the user typing "continue", up to three times.
- A response truncated in the middle of a tool call gets the same follow-up; the model
  sees its own cut-off output and can issue the call again.
- `stopReason` is the only signal used. A provider that truncates without reporting
  `"length"` is not caught.
