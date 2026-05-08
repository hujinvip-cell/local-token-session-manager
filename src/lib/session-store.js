import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const CODEX_HOME = process.env.CODEX_HOME || `${homedir()}/.codex`;
const CLAUDE_HOME = process.env.CLAUDE_HOME || `${homedir()}/.claude`;
const GEMINI_HOME = process.env.GEMINI_HOME || `${homedir()}/.gemini`;
const CACHE_TTL_MS = 4000;

const PROVIDER_CONFIG = {
  codex: {
    id: "codex",
    label: "Codex",
    home: CODEX_HOME,
    stateDb: `${CODEX_HOME}/state_5.sqlite`,
    sessionIndex: `${CODEX_HOME}/session_index.jsonl`,
    supportsArchive: true,
    supportsDelete: true
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    home: CLAUDE_HOME,
    projectsDir: `${CLAUDE_HOME}/projects`,
    supportsArchive: false,
    supportsDelete: true
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    home: GEMINI_HOME,
    historyDir: `${GEMINI_HOME}/history`,
    tempDir: `${GEMINI_HOME}/tmp`,
    supportsArchive: false,
    supportsDelete: true
  }
};

let cachedSnapshot = null;
let cachedAt = 0;

function buildSessionId(provider, rawId) {
  return `${provider}:${rawId}`;
}

function compactText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\uFEFF/g, "")
    .trim();
}

function truncateText(value, limit) {
  const compacted = compactText(value);
  if (compacted.length <= limit) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, limit - 1))}…`;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatIsoDate(value) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0")
  ].join("-");
}

function classifySessionType(session) {
  if (session.approvalMode === "never" || session.title?.startsWith("Automation:")) {
    return "automation";
  }

  if (session.source === "api") {
    return "api";
  }

  return "web";
}

function estimateCost(tokens, model) {
  const normalized = String(model || "").toLowerCase();
  const perMillion =
    normalized.includes("gpt-5") ? 5 :
    normalized.includes("gpt-4") ? 4 :
    normalized.includes("claude") ? 6 :
    normalized.includes("gemini") ? 2 :
    normalized.includes("gpt-3.5") ? 0.5 :
    1;

  return (tokens / 1_000_000) * perMillion;
}

function normalizeConversationRole(role) {
  if (role === "user" || role === "assistant") {
    return role;
  }

  return null;
}

function isPrimaryCodexLimit(rateLimits) {
  return rateLimits?.limit_id === "codex";
}

function pushConversationMessage(messages, message) {
  const role = normalizeConversationRole(message.role);
  const content = String(message.content || "").trim();

  if (!role || !content) {
    return;
  }

  const compactedContent = compactText(content);
  const last = messages.at(-1);
  if (last?.role === role && compactText(last.content) === compactedContent) {
    return;
  }

  messages.push({
    role,
    content,
    timestamp: message.timestamp || null
  });
}

function extractTextFromContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (typeof part?.text === "string") {
        return part.text;
      }

      if (typeof part?.input_text === "string") {
        return part.input_text;
      }

      if (typeof part?.output_text === "string") {
        return part.output_text;
      }

      if (typeof part?.message === "string") {
        return part.message;
      }

      if (typeof part?.content === "string") {
        return part.content;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function runSqlJson(sql) {
  try {
    const output = execFileSync("sqlite3", ["-json", PROVIDER_CONFIG.codex.stateDb, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }).trim();

    return output ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

function runSql(sql) {
  execFileSync("sqlite3", [PROVIDER_CONFIG.codex.stateDb, sql], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
}

function loadIndexedIds() {
  try {
    const lines = readFileSync(PROVIDER_CONFIG.codex.sessionIndex, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return new Set(
      lines
        .map((line) => {
          try {
            return JSON.parse(line)?.id;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function loadIndexEntries() {
  try {
    return readFileSync(PROVIDER_CONFIG.codex.sessionIndex, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return { raw: line, parsed: JSON.parse(line) };
        } catch {
          return { raw: line, parsed: null };
        }
      });
  } catch {
    return [];
  }
}

function inferCodexLinkStatus(thread, indexedIds) {
  const hasRollout = Boolean(thread.rollout_path && existsSync(thread.rollout_path));
  const hasWorkspace = Boolean(thread.cwd && existsSync(thread.cwd));
  const hasIndexEntry = indexedIds.has(thread.id);

  if (!hasRollout) {
    return {
      linkStatus: "broken",
      issueReason: "会话原始记录缺失，无法读取完整详情。"
    };
  }

  if (!hasWorkspace || !hasIndexEntry) {
    const reasons = [];

    if (!hasWorkspace) {
      reasons.push("工作目录不存在");
    }

    if (!hasIndexEntry) {
      reasons.push("全局会话索引缺少该记录");
    }

    return {
      linkStatus: "partial",
      issueReason: reasons.join("；")
    };
  }

  return {
    linkStatus: "healthy",
    issueReason: ""
  };
}

function inferGenericLinkStatus({ sourcePath, workspacePath }) {
  const hasSource = Boolean(sourcePath && existsSync(sourcePath));
  const hasWorkspace = Boolean(workspacePath && existsSync(workspacePath));

  if (!hasSource) {
    return {
      linkStatus: "broken",
      issueReason: "会话文件缺失。"
    };
  }

  if (!hasWorkspace) {
    return {
      linkStatus: "partial",
      issueReason: "工作目录不存在。"
    };
  }

  return {
    linkStatus: "healthy",
    issueReason: ""
  };
}

function isPathInsideHome(targetPath, homePath) {
  if (!targetPath || !homePath) {
    return false;
  }

  const resolvedTarget = resolve(targetPath);
  const resolvedHome = resolve(homePath);
  return resolvedTarget === resolvedHome || resolvedTarget.startsWith(`${resolvedHome}/`);
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function parseCodexSessionMessages(rolloutPath, { messageLimit = 80 } = {}) {
  if (!rolloutPath || !existsSync(rolloutPath)) {
    return { messageCount: 0, lastMessages: [], sessionMeta: null, usage: null };
  }

  try {
    const lines = readFileSync(rolloutPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    let sessionMeta = null;
    const messages = [];
    let latestUsage = null;
    let latestPrimaryUsage = null;

    lines.forEach((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }

      if (record.type === "session_meta") {
        sessionMeta = record.payload || null;
        return;
      }

      if (record.type === "response_item" && record.payload?.type === "message") {
        const text = extractTextFromContent(record.payload.content);
        pushConversationMessage(messages, {
          role: record.payload.role,
          content: text,
          timestamp: record.timestamp || null
        });
        return;
      }

      if (record.type === "event_msg" && record.payload?.type === "user_message") {
        pushConversationMessage(messages, {
          role: "user",
          content: record.payload.message,
          timestamp: record.timestamp || null
        });
        return;
      }

      if (record.type === "event_msg" && record.payload?.type === "agent_message") {
        pushConversationMessage(messages, {
          role: "assistant",
          content: record.payload.message || record.payload.text,
          timestamp: record.timestamp || null
        });
        return;
      }

      if (record.type === "event_msg" && record.payload?.type === "token_count" && record.payload?.rate_limits) {
        latestUsage = record.payload.rate_limits;
        if (isPrimaryCodexLimit(record.payload.rate_limits)) {
          latestPrimaryUsage = record.payload.rate_limits;
        }
      }
    });

    return {
      messageCount: messages.length,
      lastMessages: messageLimit === null ? messages : messages.slice(-messageLimit),
      sessionMeta,
      usage: latestPrimaryUsage || latestUsage
    };
  } catch {
    return { messageCount: 0, lastMessages: [], sessionMeta: null, usage: null };
  }
}

function normalizeBaseSession(session) {
  return {
    ...session,
    tags: session.tags || [],
    capabilities: session.capabilities || {
      canArchive: false,
      canUnarchive: false,
      canDelete: false
    }
  };
}

function normalizeCodexThread(thread, indexedIds, { messageLimit = 6 } = {}) {
  const detail = parseCodexSessionMessages(thread.rollout_path, { messageLimit });
  const { linkStatus, issueReason } = inferCodexLinkStatus(thread, indexedIds);
  const status = linkStatus === "broken" ? "error" : thread.archived ? "archived" : "active";
  const rawTitle = compactText(thread.title) || compactText(thread.first_user_message) || thread.id;
  const normalizedTitle = rawTitle.includes("Automation:")
    ? compactText(rawTitle.split("\n")[0])
    : rawTitle;
  const summarySource = compactText(thread.first_user_message) || compactText(detail.lastMessages.at(-1)?.content) || "";

  return normalizeBaseSession({
    id: buildSessionId("codex", thread.id),
    rawId: thread.id,
    provider: "codex",
    providerLabel: PROVIDER_CONFIG.codex.label,
    providerHome: PROVIDER_CONFIG.codex.home,
    title: truncateText(normalizedTitle, 72),
    status,
    linkStatus,
    createdAt: new Date(thread.created_at_ms || 0).toISOString(),
    updatedAt: new Date(thread.updated_at_ms || 0).toISOString(),
    archivedAt: thread.archived_at ? new Date(thread.archived_at).toISOString() : null,
    messageCount: detail.messageCount,
    summary: truncateText(summarySource, 180),
    sourcePath: thread.rollout_path,
    indexPath: indexedIds.has(thread.id) ? PROVIDER_CONFIG.codex.sessionIndex : null,
    workspacePath: thread.cwd,
    tags: [thread.model, thread.approval_mode === "never" ? "自动化" : null].filter(Boolean),
    issueReason,
    lastMessages: detail.lastMessages,
    tokenUsage: Number(thread.tokens_used || 0),
    model: thread.model || null,
    approvalMode: thread.approval_mode || null,
    source: detail.sessionMeta?.source || null,
    usage: detail.usage,
    capabilities: {
      canArchive: status !== "archived",
      canUnarchive: status === "archived",
      canDelete: true
    }
  });
}

function listClaudeSessionFiles() {
  const root = PROVIDER_CONFIG.claude.projectsDir;
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.forEach((entry) => {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "sessions-index.json") {
        files.push(fullPath);
      }
    });
  }

  if (existsSync(root)) {
    walk(root);
  }

  return files;
}

function parseClaudeMessageContent(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (typeof item?.text === "string") {
        return item.text;
      }

      if (typeof item?.content === "string") {
        return item.content;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseClaudeSession(filePath, { messageLimit = 6 } = {}) {
  try {
    const lines = readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const messages = [];
    let sessionId = basename(filePath, ".jsonl");
    let cwd = null;
    let createdAt = null;
    let updatedAt = null;
    let model = null;
    let approvalMode = null;
    let tokenUsage = 0;

    lines.forEach((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }

      const timestamp = record.timestamp || record.message?.timestamp || null;
      if (timestamp) {
        if (!createdAt || new Date(timestamp).getTime() < new Date(createdAt).getTime()) {
          createdAt = timestamp;
        }
        if (!updatedAt || new Date(timestamp).getTime() > new Date(updatedAt).getTime()) {
          updatedAt = timestamp;
        }
      }

      sessionId = record.sessionId || sessionId;
      cwd = cwd || record.cwd || null;
      approvalMode = approvalMode || record.permissionMode || null;

      if (record.type === "user") {
        const content = parseClaudeMessageContent(record.message?.content);
        pushConversationMessage(messages, {
          role: "user",
          content,
          timestamp
        });
        return;
      }

      if (record.type === "assistant") {
        const content = parseClaudeMessageContent(record.message?.content);
        pushConversationMessage(messages, {
          role: "assistant",
          content,
          timestamp
        });

        model = record.message?.model || model;
        tokenUsage += Number(record.message?.usage?.total || 0);
      }
    });

    const { linkStatus, issueReason } = inferGenericLinkStatus({
      sourcePath: filePath,
      workspacePath: cwd
    });
    const status = linkStatus === "broken" ? "error" : "active";
    const firstUser = messages.find((message) => message.role === "user")?.content || "";
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.content || "";

    const fileToken = basename(filePath, ".jsonl");
    const publicId = sessionId === fileToken ? sessionId : `${sessionId}--${fileToken}`;

    return normalizeBaseSession({
      id: buildSessionId("claude", publicId),
      rawId: filePath,
      externalId: sessionId,
      provider: "claude",
      providerLabel: PROVIDER_CONFIG.claude.label,
      providerHome: PROVIDER_CONFIG.claude.home,
      title: truncateText(firstUser || sessionId, 72),
      status,
      linkStatus,
      createdAt: createdAt || new Date(statSync(filePath).birthtimeMs).toISOString(),
      updatedAt: updatedAt || new Date(statSync(filePath).mtimeMs).toISOString(),
      archivedAt: null,
      messageCount: messages.length,
      summary: truncateText(firstUser || lastAssistant, 180),
      sourcePath: filePath,
      indexPath: null,
      workspacePath: cwd,
      tags: [model].filter(Boolean),
      issueReason,
      lastMessages: messageLimit === null ? messages : messages.slice(-messageLimit),
      tokenUsage,
      model,
      approvalMode,
      source: "local",
      usage: null,
      capabilities: {
        canArchive: false,
        canUnarchive: false,
        canDelete: true
      }
    });
  } catch {
    return null;
  }
}

function loadGeminiProjectRoots() {
  const roots = new Map();
  const historyDir = PROVIDER_CONFIG.gemini.historyDir;
  if (!existsSync(historyDir)) {
    return roots;
  }

  try {
    readdirSync(historyDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => {
        const markerPath = `${historyDir}/${entry.name}/.project_root`;
        if (existsSync(markerPath)) {
          const projectRoot = compactText(readFileSync(markerPath, "utf8"));
          if (projectRoot) {
            roots.set(entry.name, projectRoot);
          }
        }
      });
  } catch {
    return roots;
  }

  return roots;
}

function listGeminiSessionFiles() {
  const tempDir = PROVIDER_CONFIG.gemini.tempDir;
  const files = [];
  if (!existsSync(tempDir)) {
    return files;
  }

  try {
    readdirSync(tempDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => {
        const chatsDir = `${tempDir}/${entry.name}/chats`;
        if (!existsSync(chatsDir)) {
          return;
        }

        readdirSync(chatsDir, { withFileTypes: true })
          .filter((child) => child.isFile() && child.name.endsWith(".json"))
          .forEach((child) => {
            files.push(`${chatsDir}/${child.name}`);
          });
      });
  } catch {
    return files;
  }

  return files;
}

function parseGeminiMessageContent(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (typeof item?.text === "string") {
        return item.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseGeminiSession(filePath, projectRoots, { messageLimit = 6 } = {}) {
  try {
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    const parts = filePath.split("/");
    const tempIndex = parts.lastIndexOf("tmp");
    const projectKey = tempIndex >= 0 ? parts[tempIndex + 1] : null;
    const workspacePath = projectKey ? projectRoots.get(projectKey) || null : null;

    const messages = [];
    let tokenUsage = 0;
    let model = null;

    (payload.messages || []).forEach((message) => {
      if (message.type === "user") {
        pushConversationMessage(messages, {
          role: "user",
          content: parseGeminiMessageContent(message.content) || parseGeminiMessageContent(message.displayContent),
          timestamp: message.timestamp || null
        });
        return;
      }

      if (message.type === "gemini") {
        pushConversationMessage(messages, {
          role: "assistant",
          content: compactText(message.content),
          timestamp: message.timestamp || null
        });

        tokenUsage += Number(message.tokens?.total || 0);
        model = message.model || model;
      }
    });

    const { linkStatus, issueReason } = inferGenericLinkStatus({
      sourcePath: filePath,
      workspacePath
    });
    const status = linkStatus === "broken" ? "error" : "active";
    const firstUser = messages.find((message) => message.role === "user")?.content || "";
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.content || "";

    return normalizeBaseSession({
      id: buildSessionId("gemini", payload.sessionId || basename(filePath, ".json")),
      rawId: payload.sessionId || basename(filePath, ".json"),
      provider: "gemini",
      providerLabel: PROVIDER_CONFIG.gemini.label,
      providerHome: PROVIDER_CONFIG.gemini.home,
      title: truncateText(firstUser || payload.sessionId || basename(filePath, ".json"), 72),
      status,
      linkStatus,
      createdAt: payload.startTime || new Date(statSync(filePath).birthtimeMs).toISOString(),
      updatedAt: payload.lastUpdated || new Date(statSync(filePath).mtimeMs).toISOString(),
      archivedAt: null,
      messageCount: messages.length,
      summary: truncateText(firstUser || lastAssistant, 180),
      sourcePath: filePath,
      indexPath: null,
      workspacePath,
      tags: [model].filter(Boolean),
      issueReason,
      lastMessages: messageLimit === null ? messages : messages.slice(-messageLimit),
      tokenUsage,
      model,
      approvalMode: null,
      source: "local",
      usage: null,
      capabilities: {
        canArchive: false,
        canUnarchive: false,
        canDelete: true
      }
    });
  } catch {
    return null;
  }
}

function loadCodexSessions() {
  if (!existsSync(PROVIDER_CONFIG.codex.stateDb)) {
    return [];
  }

  const indexedIds = loadIndexedIds();
  const threads = runSqlJson(`
    select
      id,
      title,
      cwd,
      rollout_path,
      archived,
      archived_at,
      updated_at_ms,
      created_at_ms,
      tokens_used,
      model,
      approval_mode,
      first_user_message
    from threads
    order by updated_at_ms desc
  `);

  return threads.map((thread) => normalizeCodexThread(thread, indexedIds, { messageLimit: 6 }));
}

function loadClaudeSessions() {
  return listClaudeSessionFiles()
    .map((filePath) => parseClaudeSession(filePath, { messageLimit: 6 }))
    .filter(Boolean);
}

function loadGeminiSessions() {
  const projectRoots = loadGeminiProjectRoots();
  return listGeminiSessionFiles()
    .map((filePath) => parseGeminiSession(filePath, projectRoots, { messageLimit: 6 }))
    .filter(Boolean);
}

function getAvailableProviders() {
  const providers = [];

  if (existsSync(PROVIDER_CONFIG.codex.stateDb)) {
    providers.push(PROVIDER_CONFIG.codex);
  }

  if (existsSync(PROVIDER_CONFIG.claude.projectsDir)) {
    providers.push(PROVIDER_CONFIG.claude);
  }

  if (existsSync(PROVIDER_CONFIG.gemini.tempDir)) {
    providers.push(PROVIDER_CONFIG.gemini);
  }

  return providers;
}

function buildSnapshot() {
  const sessions = [
    ...loadCodexSessions(),
    ...loadClaudeSessions(),
    ...loadGeminiSessions()
  ].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());

  return {
    sessions,
    providers: getAvailableProviders(),
    lastRefreshAt: new Date().toISOString()
  };
}

function getSnapshot() {
  const now = Date.now();
  if (cachedSnapshot && now - cachedAt < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  cachedSnapshot = buildSnapshot();
  cachedAt = now;
  return cachedSnapshot;
}

function includesKeyword(session, keyword) {
  if (!keyword) {
    return true;
  }

  const normalized = keyword.trim().toLowerCase();
  const haystacks = [
    session.id,
    session.title,
    session.summary,
    session.workspacePath,
    session.sourcePath,
    session.issueReason,
    session.model,
    session.provider,
    session.providerLabel,
    ...(session.tags || [])
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return haystacks.some((value) => value.includes(normalized));
}

function withinRange(session, { startDate = "", endDate = "" } = {}) {
  if (!startDate && !endDate) {
    return true;
  }

  const updated = new Date(session.updatedAt).getTime();
  const start = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null;
  const end = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : null;

  if (start !== null && updated < start) {
    return false;
  }

  if (end !== null && updated > end) {
    return false;
  }

  return true;
}

function getCodexSessionById(id) {
  const rawId = String(id).replace(/^codex:/, "");
  const indexedIds = loadIndexedIds();
  const rows = runSqlJson(`
    select
      id,
      title,
      cwd,
      rollout_path,
      archived,
      archived_at,
      updated_at_ms,
      created_at_ms,
      tokens_used,
      model,
      approval_mode,
      first_user_message
    from threads
    where id = '${escapeSql(rawId)}'
    limit 1
  `);

  return rows[0] ? normalizeCodexThread(rows[0], indexedIds, { messageLimit: null }) : null;
}

function getGenericSessionById(id, provider) {
  const snapshot = refreshSessions();
  const exactMatch = snapshot.sessions.find((session) => session.id === id && session.provider === provider);
  if (exactMatch) {
    return exactMatch;
  }

  const normalizedId = String(id);

  if (provider === "claude") {
    const legacyId = normalizedId.replace(/^claude:/, "");
    const matches = snapshot.sessions.filter(
      (session) =>
        session.provider === "claude" &&
        (session.externalId === legacyId || session.id === `claude:${legacyId}`)
    );

    if (!matches.length) {
      return null;
    }

    const preferredMatch = matches.find((session) => !session.sourcePath?.includes("/subagents/"));
    return preferredMatch || matches[0];
  }

  if (provider === "gemini") {
    const legacyId = normalizedId.replace(/^gemini:/, "");
    return snapshot.sessions.find(
      (session) =>
        session.provider === "gemini" &&
        (session.rawId === legacyId || session.id === `gemini:${legacyId}`)
    ) || null;
  }

  return null;
}

function requireSessionActionable(id, action) {
  const session = getSessionById(id);
  if (!session) {
    throw new Error("Session not found.");
  }

  if (action === "archive" || action === "unarchive") {
    if (!session.capabilities?.[`can${action === "archive" ? "Archive" : "Unarchive"}`]) {
      throw new Error(`${session.providerLabel} 当前不支持${action === "archive" ? "归档" : "取消归档"}。`);
    }
  }

  if (action === "delete" && !session.capabilities?.canDelete) {
    throw new Error(`${session.providerLabel} 当前不支持删除。`);
  }

  return session;
}

export function refreshSessions() {
  cachedSnapshot = buildSnapshot();
  cachedAt = Date.now();
  return cachedSnapshot;
}

export function archiveSession(id) {
  const session = requireSessionActionable(id, "archive");
  if (session.provider !== "codex") {
    throw new Error("Only Codex sessions can be archived.");
  }

  const now = Date.now();
  runSql(`
    update threads
    set archived = 1,
        archived_at = ${now},
        updated_at_ms = ${now},
        updated_at = ${Math.floor(now / 1000)}
    where id = '${escapeSql(session.rawId)}'
  `);

  return refreshSessions();
}

export function unarchiveSession(id) {
  const session = requireSessionActionable(id, "unarchive");
  if (session.provider !== "codex") {
    throw new Error("Only Codex sessions can be unarchived.");
  }

  const now = Date.now();
  runSql(`
    update threads
    set archived = 0,
        archived_at = null,
        updated_at_ms = ${now},
        updated_at = ${Math.floor(now / 1000)}
    where id = '${escapeSql(session.rawId)}'
  `);

  return refreshSessions();
}

function deleteCodexSession(session) {
  if (session.sourcePath && isPathInsideHome(session.sourcePath, PROVIDER_CONFIG.codex.home) && existsSync(session.sourcePath)) {
    rmSync(session.sourcePath, { force: true });
  }

  const remainingIndexEntries = loadIndexEntries().filter((entry) => entry.parsed?.id !== session.rawId);
  writeFileSync(
    PROVIDER_CONFIG.codex.sessionIndex,
    remainingIndexEntries.map((entry) => entry.raw).join("\n") + (remainingIndexEntries.length ? "\n" : ""),
    "utf8"
  );

  runSql(`
    pragma foreign_keys = on;
    delete from threads where id = '${escapeSql(session.rawId)}';
  `);
}

function deleteClaudeSession(session) {
  if (session.sourcePath && isPathInsideHome(session.sourcePath, PROVIDER_CONFIG.claude.home) && existsSync(session.sourcePath)) {
    rmSync(session.sourcePath, { force: true });
  }
}

function deleteGeminiSession(session) {
  if (session.sourcePath && isPathInsideHome(session.sourcePath, PROVIDER_CONFIG.gemini.home) && existsSync(session.sourcePath)) {
    rmSync(session.sourcePath, { force: true });
  }

  const projectKey = session.sourcePath.split("/tmp/")[1]?.split("/")[0];
  const sessionToolOutputDir = projectKey
    ? `${PROVIDER_CONFIG.gemini.tempDir}/${projectKey}/tool-outputs/session-${session.rawId}`
    : null;
  if (isPathInsideHome(sessionToolOutputDir, PROVIDER_CONFIG.gemini.home) && existsSync(sessionToolOutputDir)) {
    rmSync(sessionToolOutputDir, { recursive: true, force: true });
  }
}

export function deleteSession(id) {
  const session = requireSessionActionable(id, "delete");

  if (session.provider === "codex") {
    deleteCodexSession(session);
  } else if (session.provider === "claude") {
    deleteClaudeSession(session);
  } else if (session.provider === "gemini") {
    deleteGeminiSession(session);
  } else {
    throw new Error("Unsupported provider.");
  }

  return refreshSessions();
}

export function listSessions(filters = {}) {
  const { sessions } = getSnapshot();
  const {
    keyword = "",
    status = "all",
    linkStatus = "all",
    workspace = "all",
    provider = "all",
    startDate = "",
    endDate = "",
    onlyIssues = "false"
  } = filters;

  return sessions
    .filter((session) => includesKeyword(session, keyword))
    .filter((session) => (status === "all" ? true : session.status === status))
    .filter((session) => (linkStatus === "all" ? true : session.linkStatus === linkStatus))
    .filter((session) => (workspace === "all" ? true : session.workspacePath === workspace))
    .filter((session) => (provider === "all" ? true : session.provider === provider))
    .filter((session) => withinRange(session, { startDate, endDate }))
    .filter((session) => {
      if (onlyIssues !== "true") {
        return true;
      }

      return session.linkStatus !== "healthy" || session.status === "error";
    })
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function getSessionById(id) {
  const snapshot = getSnapshot();
  const hint = snapshot.sessions.find((session) => session.id === id);
  if (hint) {
    if (hint.provider === "codex") {
      return getCodexSessionById(id);
    }

    return getGenericSessionById(id, hint.provider);
  }

  const normalizedId = String(id || "");
  if (normalizedId.startsWith("codex:")) {
    return getCodexSessionById(normalizedId);
  }

  if (normalizedId.startsWith("claude:")) {
    return getGenericSessionById(normalizedId, "claude");
  }

  if (normalizedId.startsWith("gemini:")) {
    return getGenericSessionById(normalizedId, "gemini");
  }

  return null;
}

export function getWorkspaces() {
  const { sessions } = getSnapshot();
  return [...new Set(sessions.map((session) => session.workspacePath).filter(Boolean))].sort();
}

export function getWorkspaceGroups() {
  const { sessions } = getSnapshot();
  const all = [...new Set(sessions.map((session) => session.workspacePath).filter(Boolean))].sort();
  const byProvider = {};

  sessions.forEach((session) => {
    if (!session.workspacePath) {
      return;
    }

    if (!byProvider[session.provider]) {
      byProvider[session.provider] = new Set();
    }

    byProvider[session.provider].add(session.workspacePath);
  });

  return {
    all,
    byProvider: Object.fromEntries(
      Object.entries(byProvider).map(([provider, workspaces]) => [provider, [...workspaces].sort()])
    )
  };
}

export function getProviders() {
  const { providers } = getSnapshot();
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    home: provider.home,
    supportsArchive: provider.supportsArchive,
    supportsDelete: provider.supportsDelete
  }));
}

export function getStats() {
  const snapshot = getSnapshot();
  const { sessions, lastRefreshAt } = snapshot;
  const total = sessions.length;
  const active = sessions.filter((session) => session.status === "active").length;
  const archived = sessions.filter((session) => session.status === "archived").length;
  const error = sessions.filter((session) => session.status === "error").length;
  const brokenLinks = sessions.filter((session) => session.linkStatus !== "healthy").length;
  const totalTokens = sessions.reduce((sum, session) => sum + (session.tokenUsage || 0), 0);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const createdLast7Days = sessions.filter((session) => new Date(session.createdAt).getTime() >= sevenDaysAgo).length;
  const latestUsageSession =
    sessions.find((session) => isPrimaryCodexLimit(session.usage) && (session.usage?.primary || session.usage?.secondary)) ||
    sessions.find((session) => session.provider === "codex" && (session.usage?.primary || session.usage?.secondary)) ||
    null;
  const primaryRemainingPercent = latestUsageSession?.usage?.primary
    ? Math.max(0, 100 - Number(latestUsageSession.usage.primary.used_percent || 0))
    : null;
  const weeklyRemainingPercent = latestUsageSession?.usage?.secondary
    ? Math.max(0, 100 - Number(latestUsageSession.usage.secondary.used_percent || 0))
    : null;

  const trend = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - offset);

    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);

    const count = sessions.filter((session) => {
      const createdAt = new Date(session.createdAt).getTime();
      return createdAt >= day.getTime() && createdAt < nextDay.getTime();
    }).length;

    trend.push({
      date: day.toISOString().slice(5, 10),
      count
    });
  }

  const providers = Object.values(
    sessions.reduce((accumulator, session) => {
      if (!accumulator[session.provider]) {
        accumulator[session.provider] = {
          id: session.provider,
          label: session.providerLabel,
          sessions: 0,
          tokens: 0
        };
      }

      accumulator[session.provider].sessions += 1;
      accumulator[session.provider].tokens += Number(session.tokenUsage || 0);
      return accumulator;
    }, {})
  ).sort((left, right) => right.sessions - left.sessions);

  return {
    total,
    active,
    archived,
    error,
    brokenLinks,
    createdLast7Days,
    totalTokens,
    usage: {
      primaryRemainingPercent,
      weeklyRemainingPercent
    },
    trend,
    providers,
    lastRefreshAt,
    dataSource: {
      codex: existsSync(PROVIDER_CONFIG.codex.stateDb)
        ? {
            home: PROVIDER_CONFIG.codex.home,
            stateDb: PROVIDER_CONFIG.codex.stateDb,
            sessionIndex: PROVIDER_CONFIG.codex.sessionIndex
          }
        : null,
      claude: existsSync(PROVIDER_CONFIG.claude.projectsDir)
        ? {
            home: PROVIDER_CONFIG.claude.home,
            projectsDir: PROVIDER_CONFIG.claude.projectsDir
          }
        : null,
      gemini: existsSync(PROVIDER_CONFIG.gemini.tempDir)
        ? {
            home: PROVIDER_CONFIG.gemini.home,
            historyDir: PROVIDER_CONFIG.gemini.historyDir,
            tempDir: PROVIDER_CONFIG.gemini.tempDir
          }
        : null
    }
  };
}

export function getUsageStats({ range = "30d" } = {}) {
  const { sessions, lastRefreshAt } = getSnapshot();
  const now = new Date();
  const today = startOfDay(now);
  const dayMs = 24 * 60 * 60 * 1000;
  const rangeDays = range === "7d" ? 7 : range === "90d" ? 90 : range === "365d" ? 365 : 30;
  const fromDate = new Date(today.getTime() - (rangeDays - 1) * dayMs);
  const currentYear = now.getFullYear();

  const withTokens = sessions.map((session) => ({
    ...session,
    type: classifySessionType(session),
    tokens: Number(session.tokenUsage || 0),
    createdTime: new Date(session.createdAt).getTime()
  }));

  const sumTokens = (items) => items.reduce((sum, session) => sum + session.tokens, 0);
  const inRange = (start, end = Date.now()) =>
    withTokens.filter((session) => session.createdTime >= start && session.createdTime <= end);

  const todayTokens = sumTokens(inRange(today.getTime()));
  const weekTokens = sumTokens(inRange(today.getTime() - 6 * dayMs));
  const monthTokens = sumTokens(inRange(today.getTime() - 29 * dayMs));
  const yearTokens = sumTokens(
    withTokens.filter((session) => new Date(session.createdAt).getFullYear() === currentYear)
  );
  const totalTokens = sumTokens(withTokens);

  const selectedSessions = inRange(fromDate.getTime());
  const selectedTokens = sumTokens(selectedSessions);
  const modelMap = new Map();
  selectedSessions.forEach((session) => {
    const model = session.model || `${session.providerLabel} / Unknown`;
    const current = modelMap.get(model) || {
      name: model,
      calls: 0,
      tokens: 0,
      estimatedCost: 0
    };

    current.calls += 1;
    current.tokens += session.tokens;
    current.estimatedCost += estimateCost(session.tokens, model);
    modelMap.set(model, current);
  });

  const modelUsage = [...modelMap.values()]
    .map((item) => ({
      ...item,
      status: item.estimatedCost > 50 ? "HIGH-COST" : item.tokens > 1_000_000 ? "OPTIMIZED" : "NORMAL"
    }))
    .sort((left, right) => right.tokens - left.tokens);

  const typeLabels = {
    api: "API 接口调用",
    web: "交互式会话",
    automation: "自动化脚本"
  };
  const typeUsage = ["api", "web", "automation"].map((type) => {
    const tokens = sumTokens(selectedSessions.filter((session) => session.type === type));
    return {
      type,
      label: typeLabels[type],
      tokens,
      percent: selectedTokens ? Math.round((tokens / selectedTokens) * 100) : 0
    };
  });

  const trend = [];
  for (let offset = rangeDays - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getTime() - offset * dayMs);
    const nextDay = new Date(day.getTime() + dayMs);
    const tokens = sumTokens(
      withTokens.filter((session) => session.createdTime >= day.getTime() && session.createdTime < nextDay.getTime())
    );

    trend.push({
      date: formatIsoDate(day),
      label: `${String(day.getMonth() + 1).padStart(2, "0")}/${String(day.getDate()).padStart(2, "0")}`,
      tokens
    });
  }

  return {
    range,
    dateRangeLabel: `${formatIsoDate(fromDate)} — ${formatIsoDate(today)}`,
    lastRefreshAt,
    cards: {
      todayTokens,
      weekTokens,
      monthTokens,
      yearTokens,
      totalTokens
    },
    modelUsage,
    typeUsage,
    trend
  };
}
