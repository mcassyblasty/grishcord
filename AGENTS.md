# Grishcord Agent Instructions

## Purpose And Scope
- These instructions apply to Codex and similar repo-aware coding agents working anywhere in this repository.
- Use them as the default baseline unless the user gives a task-specific override.
- Keep changes repo-specific, practical, and minimal. Do not invent broader process than this repo already uses.

## Repo Truths
- Main product surfaces live in `backend/`, `frontend/`, `bot/`, and the installer and operations scripts under `scripts/` plus top-level shell helpers.
- The canonical app and release version is the top-level `VERSION` file.
- The canonical human-readable release history is `docs/CHANGELOG.md`.
- `backend/package.json` and `bot/package.json` are not the release source of truth. Do not change their `version` fields unless the task is specifically about package publishing or package metadata.

## Release And Version Rules
- Before wrapping up a change, decide whether the shipped behavior changed enough to require a version bump.
- Follow the repo's semantic-ish release style:
  - Patch: bug fixes, polish, ops hardening, UI tweaks, and small self-contained features.
  - Minor: broader or more substantial new capabilities that meaningfully expand what Grishcord can do.
  - Major: breaking API, schema, deployment, or workflow changes that require manual migration or operator intervention.
- Do not bump the version for tests-only, refactors-only, comments-only, or docs-only changes unless the user explicitly asks for a release/version update.
- If a version bump is needed, update `VERSION` and add a matching new top entry in `docs/CHANGELOG.md` on the same date.
- Keep changelog entries concise and grouped under `Added`, `Changed`, and `Fixed` only when those headings are actually needed.

## Docs Hygiene
- Update `README.md` when install steps, config, deployment behavior, operator workflows, or other user-facing behavior changes.
- Update files under `docs/` only when the documented behavior actually changed.
- Do not make broad documentation edits just because code changed nearby.

## Test Defaults
- Prefer the smallest relevant verification first, then broaden only as needed.
- Backend changes: run the narrowest relevant backend test first, or use `cd backend && npm test` when a targeted test is not obvious.
- Bot changes: run `cd bot && npm test`.
- Frontend utility or state logic changes: run `node --test frontend/tests/*.test.js`.
- Installer or operations script changes: run the most relevant shell check first; use `make install-sanity` as the broader gate when appropriate.
- In the final response, always say what was tested, what was not tested, and any important remaining risk.

## Safety And Worktree Rules
- Never edit `.env`, `.install.env`, `.aibot.env`, `.ollama.env`, secrets, or live data paths unless the user explicitly asks.
- Treat `backend/node_modules/` and `backend/.npm-cache/` as generated noise unless the task is specifically about dependencies or install behavior.
- Preserve unrelated user changes already in the worktree.
- Avoid destructive git cleanup. Do not use commands like `git reset --hard` or revert unrelated files unless the user explicitly asks.
