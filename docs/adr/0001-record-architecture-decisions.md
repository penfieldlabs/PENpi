# 1. Record architecture decisions

- Status: Accepted
- Date: 2026-06-21

## Context

PENpi is being built rapidly. Decisions about architecture, dependencies, and behavior
are being made continuously and currently live only in conversation. That does not
survive turnover, does not onboard new contributors, and does not withstand external
review. We want the same engineering discipline regardless of how fast we move.

## Decision

We use Architecture Decision Records (Michael Nygard format) stored in `docs/adr/`,
numbered `NNNN-kebab-title.md`, one decision per file, each with Context / Decision /
Consequences and a Status. ADRs are immutable once Accepted; a decision is changed by
adding a new ADR that supersedes the prior one. Any change that constitutes an
architectural decision must add or update an ADR in the same change set.

## Consequences

- Rationale is durable, reviewable, and discoverable.
- New contributors (human or agent) can read the "why", not just the "what".
- Small per-decision overhead — accepted as the cost of doing it properly.
