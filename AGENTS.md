# Instructions for coding agents

These rules bind every AI agent that works in this repository. The reasons are in
[security.md](docs/security.md#commit-identity-hygiene) and [roadmap.md](docs/roadmap.md#how-we-work).
They are [the site's rules](https://github.com/IHaveASegway/website/blob/main/AGENTS.md), with the
bakery's own at the end.

- **Use the repository's git identity**, the GitHub noreply address. Check it with
  `git config --show-origin user.email`. Never change git configuration to get past a refusal.
- **Confirm the hooks are on before your first commit**: `git config core.hooksPath` must print
  `.githooks` (`pnpm install` warns when it does not). If it prints anything else, stop and ask.
  Never commit without the hooks, and never turn them on or off yourself.
  - **One exception, Joseph's decision of 2026-10-25: a Claude Code cloud session commits and
    pushes without them.** Its machine has no private rules file, so the hooks would refuse every
    commit, and the file is never copied anywhere else. CI's `firewall` job, which holds the rules,
    scans every push instead, but on this public repository a pushed branch is public before that
    scan runs ([security.md](docs/security.md#the-content-firewall-here)). So a cloud session reads its own
    changes against the pull request checklist's firewall classes before each commit, still never
    sets `core.hooksPath`, and says in each pull request that it committed without the hooks.
- **Commit with `TZ=UTC`** (`TZ=UTC git commit ...`), so commit dates record `+0000` and no time
  zone.
- **Never use `--no-verify`.** A hook that refuses is the content firewall working: fix the cause,
  or stop and ask.
- **Add no `Co-authored-by` trailer** unless its address is in
  `scripts/firewall/allowed-identities.txt`. CI fails any other address.
- **Never force-push a pull request branch.** The repository is public, so a replaced commit stays
  reachable by its SHA in every clone and cache. Fix forward with a
  new commit; merge `main` into the branch instead of rebasing. Never push to `main`.
- **Never commit a firewall term**, in any form: code, tests, fixtures, docs, file names, commit
  messages or pull request text. The rules live only in the private file. Tests use the throwaway
  rules in `scripts/firewall/test.sh`.

The bakery's own rules:

- **Synthetic data only.** Never a real person, business, address or email in code, tests, fixtures,
  docs or seeds.
- **Sandbox Stripe keys only, and no key in the repository.** Keys are Worker secrets.
- **`.dev.vars` is never committed.** `.dev.vars.example` holds names, never values.
- **No `setTimeout`, `setInterval` or wall-clock reads inside a Durable Object class.** Use alarms
  for anything timed and the `Clock` port for the time ([architecture.md](docs/architecture.md)).
- **Before every commit that touches Rust**, run `cargo fmt`, `cargo clippy --all-targets -- -D warnings`
  and `cargo test`, and fix what they report.
- **Every number in a doc carries its date and source.** Prices, limits and versions are "as of"
  a date, with a link.
