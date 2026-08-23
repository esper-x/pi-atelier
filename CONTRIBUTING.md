# Contributing to Pi Atelier

Thanks for helping improve Pi Atelier. It is an interactive Pi TUI extension, so contributions should preserve a focused user experience and include evidence that behavior works at runtime.

## Before you start

- **Open an issue first** for non-trivial work, including new user-visible behavior, configuration, public or runtime integration, and architecture changes. Describe the problem and intended outcome before implementation. Typo-only or documentation-only fixes and narrowly scoped, obvious bug fixes may go directly to a pull request. If you are unsure whether the work is non-trivial, open an issue first.
- Fork the repository and create your branch from the current `main`. Do not develop against an old release. Fetch the current `main` and rebase your branch as needed before requesting review.
- Keep each pull request to one coherent change or user-facing behavior. Focused documentation, test, refactor, and maintenance changes are welcome; unrelated bundles should be split into separate pull requests.
- Do not change maintainer or agent workflow files (`AGENTS.md`, `.agents/`, or `.claude/`) unless the agreed issue explicitly requires it.

## Set up a checkout

Pi Atelier requires Node.js `22.19.0` or newer, Pi `0.81.0` or newer, and an interactive TUI.

```bash
npm install
```

Add the Pi Atelier repository as `upstream` once, then fetch and rebase the current `main` before validating your branch:

```bash
git remote add upstream https://github.com/michaelmjhhhh/pi-atelier.git # once
git fetch upstream main
git rebase upstream/main
```

If `upstream` already exists, skip the first command. Run the required checks before opening a pull request and again before updating it. `npm run check` is mandatory for every PR, including docs-only PRs, and is the complete repository gate:

```bash
npm run check
git diff --check upstream/main...HEAD
```

The committed-PR comparison in `git diff --check upstream/main...HEAD` catches whitespace errors against updated `main`; run it after fetching and rebasing. `npm run check` runs strict TypeScript checking, Biome linting and format checking, Vitest, and package-content verification.

Use the extension in the TUI when validating behavior. After `npm install`, use the repository-local CLI for reproducibility:

```bash
npx --no-install pi -e .
```

A globally installed `pi -e .` is equivalent when it matches the supported Pi version.

## Tests and validation

Behavior changes need regression coverage through the public or runtime seams that users exercise, not only assertions against isolated pure helpers. Choose the cases that match the risk of your change. For configuration, event, or sidebar work, consider persisted `false` values and defaults, malformed or error payloads, empty states, session start/tree/lifecycle transitions, stale events, hidden state, and the active UI path.

Changes to the TUI (including the sidebar, footer, menus, and overlays) require all of the following:

1. Automated tests for the changed behavior.
2. Manual validation with `npx --no-install pi -e .` in an interactive terminal (a globally installed equivalent is acceptable when it matches the supported Pi version).
3. A screenshot or recording URL, or an attached artifact, showing the relevant result.
4. The evidence must state terminal dimensions and context (such as OS, Pi version, and scenario) and the observed result.

For other changes, include useful automated regression tests where behavior or compatibility could regress. Explain any tests that are not practical to add.

## Documentation and changelog

For a user-visible change, update `README.md` and add an entry under the `Unreleased` section of `CHANGELOG.md` when applicable. Keep documentation aligned with the behavior actually shipped.

## Pull requests

Use the repository pull request template. A useful description states:

- the problem and solution;
- the linked issue, when an issue was required;
- the scope and non-goals;
- tests and commands run, including mandatory `npm run check` and `git diff --check upstream/main...HEAD`;
- manual validation with terminal dimensions/context, observed result, and a screenshot or recording URL or attached artifact, when applicable;
- configuration and documentation impact; and
- known limitations or compatibility considerations.

Keep the review surface small and explain meaningful trade-offs. Focused conventional-style commit subjects such as `feat:`, `fix:`, or `docs:` are recommended, but they are not a requirement.

## Releases and publishing

Contributors must not publish packages, change release versions, create tags or releases, or edit npm publishing credentials. Maintainers own merging, releases, and publishing.

## Questions

If you are unsure whether a change needs an issue, tests, or documentation, open an issue or ask in the pull request. Early context is welcome, and small, focused contributions are appreciated.
