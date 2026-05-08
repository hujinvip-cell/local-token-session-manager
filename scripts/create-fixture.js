import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const fixtureRoot = resolve(process.cwd(), "test-fixtures", "codex-home");
const sessionsDir = resolve(fixtureRoot, "sessions", "2026", "05", "06");
const stateDb = resolve(fixtureRoot, "state_5.sqlite");
const sessionIndex = resolve(fixtureRoot, "session_index.jsonl");

function ensureCleanRoot() {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
}

function createSessionFile(filePath, sessionId, cwd, userText, assistantText) {
  const lines = [
    JSON.stringify({
      timestamp: "2026-05-06T06:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        cwd,
        source: "fixture",
        cli_version: "0.0.0-test"
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-06T06:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: userText
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-06T06:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: assistantText }]
      }
    })
  ];

  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function createDatabase(activePath, archivedPath) {
  execFileSync("sqlite3", [stateDb, `
    pragma foreign_keys = on;
    create table threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      model TEXT,
      reasoning_effort TEXT,
      agent_path TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
    create table thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    insert into threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
      cli_version, first_user_message, memory_mode, model, created_at_ms, updated_at_ms
    ) values
    (
      'sess_active',
      '${activePath}',
      1778047200,
      1778048400,
      'fixture',
      'openai',
      '${resolve(process.cwd())}',
      'Fixture Active Session',
      '{"type":"workspace-write"}',
      'on-request',
      12345,
      1,
      0,
      null,
      '0.0.0-test',
      'active first message',
      'enabled',
      'gpt-5.4',
      1778047200000,
      1778048400000
    ),
    (
      'sess_archived',
      '${archivedPath}',
      1778040000,
      1778044800,
      'fixture',
      'openai',
      '${resolve(process.cwd())}',
      'Fixture Archived Session',
      '{"type":"workspace-write"}',
      'on-request',
      67890,
      1,
      1,
      1778045000000,
      '0.0.0-test',
      'archived first message',
      'enabled',
      'gpt-5.4',
      1778040000000,
      1778044800000
    );
    insert into thread_goals (
      thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
    ) values (
      'sess_archived',
      'goal_archived',
      'fixture goal',
      'active',
      1000,
      10,
      1,
      1778040000000,
      1778044800000
    );
  `], { encoding: "utf8" });
}

function createIndex() {
  const lines = [
    JSON.stringify({
      id: "sess_active",
      thread_name: "Fixture Active Session",
      updated_at: "2026-05-06T06:20:00.000Z"
    }),
    JSON.stringify({
      id: "sess_archived",
      thread_name: "Fixture Archived Session",
      updated_at: "2026-05-06T05:20:00.000Z"
    })
  ];

  writeFileSync(sessionIndex, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  ensureCleanRoot();

  const activePath = resolve(sessionsDir, "rollout-2026-05-06T14-00-00-sess_active.jsonl");
  const archivedPath = resolve(sessionsDir, "rollout-2026-05-06T13-00-00-sess_archived.jsonl");

  createSessionFile(activePath, "sess_active", resolve(process.cwd()), "active first message", "active response");
  createSessionFile(archivedPath, "sess_archived", resolve(process.cwd()), "archived first message", "archived response");
  createDatabase(activePath, archivedPath);
  createIndex();

  console.log(fixtureRoot);
}

main();
