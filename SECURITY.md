# Security Policy

## Reporting PENpi Issues

PENpi is maintained by **Penfield**. For vulnerabilities in PENpi's own
code — the `.pi/extensions/penpi/` extension, its auth/token handling, the
Penfield integration, install scripts, or fork-level changes — report privately
via [GitHub Security Advisories](https://github.com/penfieldlabs/PENpi/security/advisories)
on this repository. Do not open a public issue.

Penfield memory is trusted persistent context, but remembered text is not fresh command
authority. In normal mode PENpi wraps automatic orientation/reflection in a neutral boundary
that preserves preferences, decisions, and history while preventing memory from overriding
current instructions or independently authorizing actions. Model-level prompt injection
remains possible. Use `penpi.displayBriefing` to audit injected memory and `update_memory`
by ID to correct a poisoned record. `--penpi-raw` is a diagnostic control, not a poisoned-
memory remedy: it skips automatic `awaken`/`reflect` and their orientation/protocol prompt,
while leaving manually invoked Penfield tools available. Memory recalled manually in raw
mode arrives as ordinary tool output without the automatic orientation boundary. Do not
store secrets or executable instructions in memory. Penfield does not currently expose a
delete tool through PENpi.

## GitHub Actions trust boundary

PENpi assumes the public repository permits forks. Fork pull requests run only the `CI`
workflow through the `pull_request` event with read-only repository permissions and no
secrets. The dependency-audit workflow runs only from the base repository with read-only
permissions. Binary publication is manual, accepts only an existing version tag whose
commit is on base `main`, and does not accept an arbitrary source ref. Actions are pinned
to full commit SHAs.

For issues in the inherited Pi core (`packages/**`), the code comes from
[upstream Pi](https://github.com/earendil-works/pi); consider reporting there
per the upstream policy below so the fix reaches everyone. Pi's security model
and scope boundaries below apply to PENpi as well.

---

# Pi Security Policy (upstream, preserved)

This document should guide you about understanding the security concept behind
Pi and also where the boundaries are.

In general Pi is a coding agent that runs locally within the security boundary
of the user that is running it.  It's the responsibiltiy of the user to monitor
its operations or to contain it within a container, virtual machine or other
Sandbox solution.

Pi treats the local user account and files writable by that account as inside
the same trust boundary as the Pi process itself.  If an attacker can modify files
under the user's home directory, workspace, shell startup files, environment, or
Pi configuration, they can generally influence Pi or other local developer tools.
Reports that depend on such prior local write access are not security
vulnerabilities unless they demonstrate how Pi grants that write access or crosses
an operating-system privilege boundary.

Pi relies on users installing trustworthy extensions and loading trustworthy
skills and only to use pi within trusted repositories.  This is because files
like `AGENTS.md` or instructions in comments can be used to prompt inject the
coding agent trivially and this cannot be protected against.

## Reporting a Vulnerability

If you believe you found a security vulnerability in pi or another package in
this repository, please report it privately by either:

- Emailing `security@earendil.com`, or
- Opening a private report through GitHub Security Advisories for this repository

Please include:

- A description of the issue and its impact
- Steps to reproduce, proof of concept, or relevant logs
- Affected package, version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports.  We will review
reports and coordinate disclosure as appropriate.

## Scope

Security issues in the distributed packages, command-line tools, APIs, and
repository code are in scope as well as earendil operated infrastricture
on `pi.dev`.

## Out Of Scope

- Local code execution or sandboxing behavior (the Pi coding agent intentionally does not have a sandbox)
- Behavior of pi extensions or skills installed by the user
- Risks from working in untrusted repositories
- Risks from installing untrusted extensions, skills, packages, or tools
- Isuses caused by non trustworthy MITM proxies
- Public internet exposure of a Pi installation
- Prompt injection attacks
- Exposed secrets that are third-party/user-controlled credentials
- Reports requiring the ability to create, modify, delete, or replace files,
  directories, symlinks, environment variables, shell configuration, or other
  user-controlled local state on the target machine. This includes `~/.pi`,
  `~/.pi/agent/models.json`, workspace files, `AGENTS.md`, skills, extensions,
  extension configuration, dotfiles, and files synchronized through NFS, roaming
  profiles, or dotfile managers, unless the report shows how Pi itself grants
  that access.
- Issues caused by intentionally weakened user configuration.
- Resource/DOS claims that require trusted local input/config against the pi coding agent.
- Reports about malicious model output.
- User-approved or user-initiated local actions presented as vulnerabilities.

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass
with demonstrated impact.  Reports that only show expected local-agent behavior,
prompt injection, or a malicious trusted extension/skill are not security
vulnerabilities under this model.

For example, a report showing that malicious contents written to a trusted Pi
configuration file cause Pi to execute commands, load attacker-controlled tools,
send credentials to an attacker-controlled endpoint, or otherwise change behavior
is out of scope.

When possible, include the exact affected path, package version or commit SHA,
configuration, and a proof of concept against the latest release or latest
`main`.  For dependency reports, include evidence that the shipped dependency is
affected and that the issue is reachable through Pi.  For exposed-secret reports,
include evidence that the credential is owned by Earendil or grants access to
Earendil-operated infrastructure or services.
