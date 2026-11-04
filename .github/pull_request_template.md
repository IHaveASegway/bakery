## What and why

<!-- One paragraph: the need, what changed, and the roadmap item or ADR it serves. -->

## Content firewall: what regex cannot see

CI scans the text. These need a person ([security.md](../docs/security.md#the-content-firewall-here)).
Anything sensitive goes in the private record, never in this pull request: its text goes public
with the repository.

- [ ] No employer, private venture, product, internal system, colleague, internal metric, city or
      region appears in any changed file, file name, commit message, branch name or this
      description, paraphrased or not.
- [ ] Read with the rest of the repository, nothing here narrows to an employer, and no seed
      name, persona or place resembles a real person, business or address.
- [ ] Images and screenshots show owned work only, cropped to the content, with no work tool, no
      browser chrome and no colo.
- [ ] Every image and PDF is free of EXIF, XMP and IPTC metadata (the pre-commit hook checks it).
- [ ] No PDF was added, or each one's text and metadata was read.
- [ ] No archive, Office document or other packed file (zip, docx, xlsx, gz) was added. No rule
      can read inside one, so the firewall refuses it: commit what it holds instead.
- [ ] No WebAssembly was committed. The API bundle is built in CI from scanned source and is not
      committed ([delivery.md](../docs/delivery.md#shape)); the firewall reads a module's names and
      data, not what its code computes.
- [ ] No new name outside the repository (the workers.dev subdomain, a Worker, Stripe, Google
      Cloud or GitHub OAuth app name, an account name), or it names nothing private.
- [ ] Re-read the title and description after any edit: CI scans an edited title or description
      again (pr-text.yml), but on a public repository the edit is public before the scan runs.

## Accessibility: what axe cannot see

- [ ] Keyboard only: every control is reachable in order, its focus is visible, and nothing traps
      focus. A VoiceOver pass (macOS) reads each changed page and control sensibly, with reduced
      motion on, in light and in dark.

## Cloud session

- [ ] This pull request was committed by a Claude Code cloud session without the hooks, as
      [AGENTS.md](../AGENTS.md) allows. Tick it only when true; the changes were read against the
      firewall list above before each commit.
