# AI Session Manager

Local CLI and web UI for viewing and managing Codex, Claude Code, and Gemini CLI sessions, including archived sessions, link health, stats, filters, and detail inspection.

## Current Scope

This repository currently contains:

- a product and UI design document
- a no-dependency local web prototype
- a CLI entrypoint for serving the UI and printing session summaries
- a real local Codex session scanner backed by `~/.codex/state_5.sqlite`
- local Claude Code and Gemini CLI session scanners based on their session files
- real archive, unarchive, and delete actions for Codex local metadata
- delete actions for Claude Code and Gemini CLI session files
- a disposable fixture generator for safe action testing

## Run

```bash
npm start
```

Then open `http://127.0.0.1:4123`.

## CLI

```bash
npm run serve
npm run scan
npm run design
npm run fixture
```

## Safe Testing

Generate an isolated local Codex fixture:

```bash
npm run fixture
CODEX_HOME=/Users/hujin/WebstormProjects/codex-session-manager/test-fixtures/codex-home npm run serve
```

This lets you verify Codex archive, unarchive, and delete actions without touching your real `~/.codex` data.

## Provider Support

- `Codex`: read / archive / unarchive / delete
- `Claude Code`: read / delete
- `Gemini CLI`: read / delete

## MVP Targets

- scan local Codex / Claude Code / Gemini CLI sessions
- show active and archived sessions in one place
- display link health
- filter and search
- show summary stats
- inspect session details
- delete sessions
- unarchive Codex sessions
