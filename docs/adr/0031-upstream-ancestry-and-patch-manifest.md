# 31. Record upstream ancestry and list every patch against it

- Status: Accepted
- Date: 2026-10-13

## Context

PENpi 0.4.0 rebased onto upstream Pi v1.1.0 by replacing `main`'s tree, so `main` did not
record that it contains upstream: git saw no common history. The next upstream merge would
then conflict on every file both sides touched. The port also carried silent mistakes:
files upstream had deleted came back, and files copied from 0.3.2 lost upstream's changes.
Nothing distinguished a deliberate PENpi change from an accident.

## Decision

Follow standard fork practice. `main` records upstream Pi v1.1.0 (`abe508e1b`) as merged
through an `-s ours` merge commit that keeps PENpi's tree unchanged; later upstream releases
are merged the same way. PENpi's own work stays one squashed commit per release, so a
release commit is always on `main`'s first-parent history, and the release workflow accepts
only such a tag.

Once ancestry is recorded, any file that still differs from upstream counts as PENpi's
change at the next merge and survives silently. So every difference must be intentional:
`docs/UPSTREAM_PATCHES.txt` records the upstream base and one line per differing path with
its reason, and `npm run check:upstream-patches` (in `npm run check` and CI) fails when the
set of differing paths and the list are not identical.

## Consequences

- Upstream merges are ordinary merges; conflicts appear only where PENpi changed a file.
- Adding or reverting a difference from upstream means editing the manifest in the same
  change; an upstream merge updates the base line.
- Every upstream commit is an ancestor of `main`, so reachability no longer identifies a
  PENpi release; the release workflow checks the first-parent history instead.
- `push.followTags` must stay off: upstream's annotated tags become reachable and would be
  published by a tag-following push.
