# Codex Session Manager Design

## Positioning

Codex Session Manager is a local management tool for Codex sessions. It complements the chat UI by giving users a single control surface for active sessions, archived sessions, broken links, and operational actions.

The agreed product shape is:

- CLI for local control and quick inspection
- local web UI for browsing, filtering, and operating on sessions

## Core Goals

- make archived sessions visible and manageable
- expose link health clearly
- support fast filtering and searching
- provide summary stats at a glance
- show session details without navigating away from the list

## MVP Functional Scope

### Session List

Each row should show:

- title
- session status
- link status
- message count
- workspace/source
- updated time
- summary snippet

Default sort is most recently updated first.

### Link Status

Link status is defined as:

- `healthy`: session record and required linked resources exist
- `partial`: session exists but one or more secondary linked resources are missing
- `broken`: session record exists but its core target is missing or unusable

### Filters

- keyword search
- status filter
- link status filter
- time range
- workspace filter
- only show problematic sessions

### Stats

- total sessions
- active sessions
- archived sessions
- broken or problematic links
- created in last 7 days
- recent trend

### Detail Panel

- title and identifiers
- timestamps
- archive state
- link state and issue reason
- source, index, workspace paths
- last messages
- summary
- actions

### Operations

- delete session
- unarchive session
- rescan one session
- refresh all

## UI Structure

### Top Bar

- product title
- search input
- refresh action
- rescan action
- batch action entry

### Stats Row

- compact cards for primary totals
- small trend chart

### Main Workspace

- left: filters
- center: session table
- right: session detail panel

This is a single-screen workflow optimized for desktop usage.

## Data Model

```ts
type SessionRecord = {
  id: string
  title: string
  status: 'active' | 'archived' | 'error'
  linkStatus: 'healthy' | 'partial' | 'broken'
  createdAt: string
  updatedAt: string
  archivedAt?: string
  messageCount: number
  summary?: string
  sourcePath: string
  indexPath?: string
  workspacePath?: string
  tags?: string[]
  issueReason?: string
  lastMessages?: {
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp?: string
  }[]
}
```

## CLI Commands

- `serve`: start the local web UI
- `scan`: print a terminal summary and eventually rebuild the index
- `design`: print current product scope and architecture intent

## Technical Direction

Current implementation uses:

- Node.js built-in HTTP server
- static web assets
- SQLite-backed thread discovery from `~/.codex/state_5.sqlite`
- session detail parsing from `~/.codex/sessions/**/*.jsonl`

Phase 2 should add:

- persistent session index
- delete/unarchive actions against real local metadata
- token usage and refresh-time metrics
