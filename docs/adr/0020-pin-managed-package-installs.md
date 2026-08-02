# 20. Pin managed package installs exactly

- Status: Accepted
- Date: 2026-07-31

## Context

PENpi declares its managed extension packages with exact versions, but package managers
normally save a caret range when installing them into Pi's generated managed package
manifest. For example, installing `pi-mcp-adapter@2.10.0` caused npm to record
`^2.10.0`. A later install could then resolve untested upstream code even though PENpi's
source configuration remained pinned.

PENpi is a tested fork of Pi. Its runtime dependencies must move only as part of a
deliberate PENpi upgrade and validation cycle.

## Decision

Managed npm-package installs always request exact save semantics from the configured
package manager:

- npm: `--save-exact`
- pnpm: `--save-exact`
- Bun: `--exact`

This applies to both initial managed installs and managed package updates. The configured
source remains the authority for a requested range, while the generated manifest records
the version actually resolved by that install.

## Consequences

- Installing PENpi cannot silently weaken an exact package pin into a caret range.
- Dependency upgrades remain controlled by PENpi maintainers and the PENpi release gate.
- The fork carries a small package-manager behavior patch that must be checked when
  adopting a newer Pi base.
