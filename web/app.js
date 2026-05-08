const state = {
  sessions: [],
  stats: null,
  meta: null,
  usageStats: null,
  isLoadingSessions: false,
  isLoadingDetail: false,
  activeTab: "dashboard",
  usageRange: "30d",
  selectedSessionId: null,
  selectedSessionDetail: null,
  selectedIds: new Set(),
  theme: localStorage.getItem("ai-session-theme") || "dark",
  filters: {
    keyword: "",
    status: "all",
    provider: "all",
    linkStatus: "all",
    workspace: "all",
    startDate: "",
    endDate: "",
    onlyIssues: false
  }
};

const labels = {
  active: "活跃",
  archived: "已归档",
  error: "异常",
  healthy: "正常",
  partial: "部分缺失",
  broken: "已失效",
  user: "用户",
  assistant: "助手",
  system: "系统",
  developer: "助手"
};

const providerLabels = {
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Gemini CLI"
};

const themeIcons = {
  light: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8Z"></path>
    </svg>
  `,
  dark: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.5"></circle>
      <path d="M12 2.5v2.2"></path>
      <path d="M12 19.3v2.2"></path>
      <path d="m4.6 4.6 1.6 1.6"></path>
      <path d="m17.8 17.8 1.6 1.6"></path>
      <path d="M2.5 12h2.2"></path>
      <path d="M19.3 12h2.2"></path>
      <path d="m4.6 19.4 1.6-1.6"></path>
      <path d="m17.8 6.2 1.6-1.6"></path>
    </svg>
  `
};

function qs(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatRelativeTime(value) {
  const target = new Date(value).getTime();
  const deltaMinutes = Math.max(0, Math.floor((Date.now() - target) / 60000));

  if (deltaMinutes < 1) {
    return "刚刚";
  }

  if (deltaMinutes < 60) {
    return `${deltaMinutes}分钟前`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}小时前`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 30) {
    return `${deltaDays}天前`;
  }

  return formatTime(value);
}

function buildQuery() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([key, value]) => {
    params.set(key, String(value));
  });
  return params.toString();
}

function markdownToHtml(content) {
  const escaped = escapeHtml(content);
  const fenced = escaped.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  return fenced.replace(/\n/g, "<br>");
}

function computePercent(value, total) {
  if (!total) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function formatTokenAmount(value) {
  const tokens = Number(value || 0);
  if (tokens >= 1_000_000_000) {
    return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  }

  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }

  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }

  return tokens.toLocaleString("zh-CN");
}

function isSelected(id) {
  return state.selectedIds.has(id);
}

function refillWorkspaceOptions() {
  const workspaceSelect = qs("#workspaceFilter");
  if (!workspaceSelect || !state.meta?.workspaceGroups) {
    return;
  }

  const selectedProvider = state.filters.provider || "all";
  const options =
    selectedProvider === "all"
      ? state.meta.workspaceGroups.all || []
      : state.meta.workspaceGroups.byProvider?.[selectedProvider] || [];
  const currentValue = state.filters.workspace;

  workspaceSelect.innerHTML = '<option value="all">目录</option>';
  options.forEach((workspace) => {
    const option = document.createElement("option");
    option.value = workspace;
    option.textContent = workspace.split("/").pop();
    workspaceSelect.append(option);
  });

  if (currentValue !== "all" && !options.includes(currentValue)) {
    state.filters.workspace = "all";
  }

  workspaceSelect.value = state.filters.workspace;
}

function renderListSkeleton() {
  const list = qs("#sessionList");
  list.classList.add("is-loading");
  list.innerHTML = Array.from({ length: 7 }, () => `
    <div class="session-row skeleton-row" aria-hidden="true">
      <div class="session-row-head">
        <div class="skeleton skeleton-checkbox"></div>
        <div class="session-row-main">
          <div class="skeleton skeleton-line skeleton-title"></div>
          <div class="skeleton-meta-row">
            <div class="skeleton skeleton-pill"></div>
            <div class="skeleton skeleton-pill"></div>
            <div class="skeleton skeleton-pill"></div>
          </div>
          <div class="skeleton skeleton-line"></div>
          <div class="skeleton skeleton-line skeleton-line-short"></div>
        </div>
        <div class="skeleton skeleton-chip"></div>
      </div>
    </div>
  `).join("");
}

function renderDetailSkeleton() {
  const detail = qs("#sessionDetail");
  detail.className = "detail-shell detail-shell-loading";
  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-header-left detail-header-left-loading">
        <div class="skeleton skeleton-icon"></div>
        <div class="skeleton skeleton-line skeleton-detail-title"></div>
      </div>
      <div class="detail-header-actions">
        <div class="skeleton skeleton-button"></div>
        <div class="skeleton skeleton-button"></div>
      </div>
    </div>
    <div class="detail-content">
      <div class="detail-meta-pane">
        <div class="detail-meta-grid">
          ${Array.from({ length: 8 }, () => `
            <div class="detail-meta-block">
              <div class="skeleton skeleton-label"></div>
              <div class="skeleton skeleton-line skeleton-line-short"></div>
            </div>
          `).join("")}
        </div>
        <div class="detail-source-row">
          <div class="skeleton skeleton-label"></div>
          <div class="skeleton skeleton-source-box"></div>
        </div>
      </div>
      <div class="chat-pane">
        <div class="chat-divider">
          <div class="chat-divider-line"></div>
          <span class="chat-divider-text">正在加载会话内容</span>
          <div class="chat-divider-line"></div>
        </div>
        <div class="message-list">
          <div class="message-row">
            <div class="skeleton skeleton-message-head"></div>
            <div class="skeleton skeleton-message-bubble"></div>
          </div>
          <div class="message-row user">
            <div class="skeleton skeleton-message-head"></div>
            <div class="skeleton skeleton-message-bubble skeleton-message-bubble-user"></div>
          </div>
          <div class="message-row">
            <div class="skeleton skeleton-message-head"></div>
            <div class="skeleton skeleton-message-bubble"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderUsagePanel() {
  if (!state.stats) {
    return;
  }

  const providerCount = state.stats.providers?.length || 0;
  const providers = state.stats.providers || [];

  qs("#membershipStatus").textContent = `来源概览 • ${providerCount} 个来源`;
  qs("#providerOverview").innerHTML = providers.length
    ? providers
        .map(
          (provider) => `
            <div class="provider-pill">
              <span class="provider-pill-name">${escapeHtml(provider.label)}</span>
              <span class="provider-pill-value">${provider.sessions}</span>
            </div>
          `
        )
        .join("")
    : '<div class="provider-pill provider-pill-muted">暂无来源</div>';
  qs("#providerRefreshMeta").textContent = `总会话 ${state.stats.total} • 异常 ${state.stats.brokenLinks} • 最近刷新 ${formatTime(state.stats.lastRefreshAt)}`;
}

function renderUsagePage() {
  if (!state.usageStats) {
    return;
  }

  const cards = [
    ["今日用量", state.usageStats.cards.todayTokens, "Tokens consumed", "↗ 实时"],
    ["本周用量", state.usageStats.cards.weekTokens, "Tokens consumed", "↘ 环比"],
    ["本月用量", state.usageStats.cards.monthTokens, "Tokens consumed", "↗ 累计"],
    ["本年用量", state.usageStats.cards.yearTokens, "Tokens consumed", "↔ 年度"],
    ["总用量", state.usageStats.cards.totalTokens, "Aggregate history", ""]
  ];

  qs("#usageDateRange").textContent = state.usageStats.dateRangeLabel;
  qs("#usageCards").innerHTML = cards
    .map(
      ([title, value, label, change], index) => `
        <div class="usage-stat-card ${index === cards.length - 1 ? "total" : ""}">
          <div class="usage-stat-card-head">
            <span>${escapeHtml(title)}</span>
            <span class="usage-stat-change">${escapeHtml(change)}</span>
          </div>
          <div class="usage-stat-value">${formatTokenAmount(value)}</div>
          <div class="usage-stat-label">${escapeHtml(label)}</div>
        </div>
      `
    )
    .join("");

  const modelRows = state.usageStats.modelUsage.slice(0, 8);
  qs("#modelUsageTable").innerHTML = `
    <div class="model-usage-header">
      <span>模型名称</span>
      <span>调用次数</span>
      <span>TOKEN 消耗</span>
      <span>估计费用</span>
      <span>状态</span>
    </div>
    ${
      modelRows.length
        ? modelRows
            .map((model, index) => {
              const statusClass = model.status === "HIGH-COST" ? "high" : "";
              return `
                <div class="model-usage-row">
                  <div class="model-name">
                    <span class="model-dot" style="background:${["#adc6ff", "#4edea3", "#ffb880", "#9aa2b6"][index % 4]}"></span>
                    <span>${escapeHtml(model.name)}</span>
                  </div>
                  <div class="model-usage-cell">${model.calls.toLocaleString("zh-CN")}</div>
                  <div class="model-usage-cell">${formatTokenAmount(model.tokens)}</div>
                  <div class="model-usage-cell model-cost">$${model.estimatedCost.toFixed(2)}</div>
                  <div><span class="model-status ${statusClass}">${escapeHtml(model.status)}</span></div>
                </div>
              `;
            })
            .join("")
        : '<div class="empty-state">当前范围内没有模型用量。</div>'
    }
  `;

  qs("#typeUsageList").innerHTML = state.usageStats.typeUsage
    .map(
      (item) => `
        <div class="type-usage-item">
          <div class="type-usage-head">
            <span>${escapeHtml(item.label)}</span>
            <span>${item.percent}%</span>
          </div>
          <div class="type-track"><div class="type-fill" style="width:${item.percent}%"></div></div>
        </div>
      `
    )
    .join("");

  renderUsageTrend();
}

function renderUsageTrend() {
  const chart = qs("#usageTrendChart");
  const trend = state.usageStats?.trend || [];
  if (!trend.length) {
    chart.innerHTML = `<div class="empty-state">暂无趋势数据。</div>`;
    return;
  }

  const width = 1200;
  const height = 360;
  const padding = 34;
  const maxTokens = Math.max(...trend.map((point) => point.tokens), 1);
  const points = trend.map((point, index) => {
    const x = padding + (index / Math.max(1, trend.length - 1)) * (width - padding * 2);
    const y = height - padding - (point.tokens / maxTokens) * (height - padding * 2);
    return { ...point, x, y };
  });
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L ${points.at(-1).x.toFixed(1)} ${height - padding} L ${points[0].x.toFixed(1)} ${height - padding} Z`;
  const ticks = [0, Math.floor((trend.length - 1) / 4), Math.floor((trend.length - 1) / 2), Math.floor(((trend.length - 1) * 3) / 4), trend.length - 1]
    .filter((value, index, array) => array.indexOf(value) === index)
    .map((index) => points[index]);

  chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Token 用量趋势">
      <defs>
        <linearGradient id="usageAreaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#adc6ff" stop-opacity="0.34" />
          <stop offset="100%" stop-color="#adc6ff" stop-opacity="0.03" />
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#usageAreaGradient)"></path>
      <path d="${line}" fill="none" stroke="#adc6ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      ${points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3" fill="#adc6ff"></circle>`).join("")}
      ${ticks
        .map(
          (point) => `
            <text x="${point.x.toFixed(1)}" y="${height - 10}" text-anchor="middle" fill="currentColor" font-size="15" font-weight="700">${escapeHtml(point.label)}</text>
          `
        )
        .join("")}
    </svg>
  `;
}

function switchTab(tab) {
  state.activeTab = tab;
  qs("#dashboardPage").classList.toggle("hidden", tab !== "dashboard");
  qs("#usagePage").classList.toggle("hidden", tab !== "usage");
  document.querySelectorAll(".top-nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });

  if (tab === "usage") {
    loadUsageStats();
  }
}

function renderList() {
  const list = qs("#sessionList");
  qs("#sessionCount").textContent = `共 ${state.sessions.length} 条结果`;

  list.classList.remove("is-loading");

  if (!state.sessions.length) {
    list.innerHTML = `<div class="empty-state">没有匹配的会话。</div>`;
    return;
  }

  list.innerHTML = state.sessions
    .map((session) => {
      const relativeTime = formatRelativeTime(session.updatedAt);
      const workspaceName = session.workspacePath?.split("/").pop() || "-";

      return `
        <div class="session-row ${session.id === state.selectedSessionId ? "selected" : ""}" data-session-id="${session.id}">
          <div class="session-row-head">
            <input class="session-select" data-select-id="${session.id}" type="checkbox" ${isSelected(session.id) ? "checked" : ""} />
            <div class="session-row-main">
              <div class="session-row-title">${escapeHtml(session.title)}</div>
              <div class="session-row-meta">
                <span class="meta-item"><span class="meta-dot"></span>${escapeHtml(providerLabels[session.provider] || session.providerLabel || session.provider || "-")}</span>
                <span class="meta-item"><span class="meta-dot"></span>${session.messageCount}</span>
                <span class="meta-item"><span class="meta-dot"></span>${escapeHtml(relativeTime)}</span>
              </div>
              <div class="session-row-summary">"${escapeHtml(session.summary || "暂无摘要")}"</div>
              <div class="session-row-path">${escapeHtml(session.workspacePath || workspaceName)}</div>
            </div>
            <span class="status-chip ${session.status}">${labels[session.status] || session.status}</span>
          </div>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".session-row").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target instanceof HTMLInputElement) {
        return;
      }

      state.selectedSessionId = row.dataset.sessionId;
      state.selectedSessionDetail = null;
      syncSelectedRow();
      renderDetail();
      loadSelectedSessionDetail().catch((error) => {
        if (error.status === 404) {
          return;
        }

        window.alert(`加载详情失败：${error.message}`);
      });
      if (window.matchMedia("(max-width: 560px)").matches) {
        qs("#sessionDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  list.querySelectorAll(".session-select").forEach((checkbox) => {
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    checkbox.addEventListener("change", (event) => {
      const id = event.target.dataset.selectId;
      if (!id) {
        return;
      }

      if (event.target.checked) {
        state.selectedIds.add(id);
      } else {
        state.selectedIds.delete(id);
      }
    });
  });
}

function syncSelectedRow() {
  const list = qs("#sessionList");
  if (!list) {
    return;
  }

  list.querySelectorAll(".session-row").forEach((row) => {
    row.classList.toggle("selected", row.dataset.sessionId === state.selectedSessionId);
  });
}

function renderDetail() {
  const detail = qs("#sessionDetail");

  if (state.isLoadingDetail && state.selectedSessionId && !state.selectedSessionDetail) {
    renderDetailSkeleton();
    return;
  }

  const session =
    state.selectedSessionDetail?.id === state.selectedSessionId
      ? state.selectedSessionDetail
      : state.sessions.find((item) => item.id === state.selectedSessionId);

  if (!session) {
    detail.className = "detail-empty";
    detail.innerHTML = `<div class="detail-empty">选择一条会话后，这里会显示会话详情、元信息和最近消息。</div>`;
    return;
  }

  detail.className = "detail-shell detail-shell-ready";

  const tags = (session.tags || [])
    .map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`)
    .join("");
  const archiveButton = session.capabilities?.canArchive || session.capabilities?.canUnarchive
    ? `<button id="toggleArchiveButton" class="detail-button" type="button">${session.status === "archived" ? "取消归档" : "归档"}</button>`
    : "";
  const deleteButton = session.capabilities?.canDelete
    ? `<button id="deleteSessionButton" class="detail-button detail-button-danger" type="button">删除</button>`
    : "";
  const capabilityNote =
    session.provider === "codex"
      ? ""
      : `<div class="detail-source-row"><span class="detail-meta-label">操作限制</span><div class="detail-source-box">${escapeHtml(session.providerLabel)} 当前仅支持查看和删除，不支持归档。</div></div>`;

  const messages = (session.lastMessages || [])
    .map((message) => {
      const role = ["user", "assistant", "system", "developer"].includes(message.role) ? message.role : "assistant";

      return `
        <div class="message-row ${role}">
          <div class="message-head">
            <span>${labels[role] || role}</span>
            <span class="message-time">${message.timestamp ? formatTime(message.timestamp) : ""}</span>
          </div>
          <div class="message-bubble">${markdownToHtml(message.content || "")}</div>
        </div>
      `;
    })
    .join("");

  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-header-left">
        <span class="detail-header-icon">📄</span>
        <span class="detail-header-title">${escapeHtml(session.title)}</span>
      </div>
      <div class="detail-header-actions">
        ${archiveButton}
        ${deleteButton}
      </div>
    </div>

    <div class="detail-content">
      <div class="detail-meta-pane">
        <div class="detail-meta-grid">
          <div class="detail-meta-block">
            <span class="detail-meta-label">Provider</span>
            <span class="detail-meta-value">${escapeHtml(session.providerLabel || providerLabels[session.provider] || session.provider || "-")}</span>
          </div>
          <div class="detail-meta-block">
            <span class="detail-meta-label">会话 ID</span>
            <span class="detail-meta-value">${escapeHtml(session.externalId || session.rawId || session.id)}</span>
          </div>
          <div class="detail-meta-block">
            <span class="detail-meta-label">模型</span>
            <span class="detail-meta-value">${escapeHtml(session.model || "-")}</span>
          </div>
          <div class="detail-meta-block">
            <span class="detail-meta-label">TOKEN 统计</span>
            <span class="detail-meta-value">${(session.tokenUsage || 0).toLocaleString("zh-CN")}</span>
          </div>
          <div class="detail-meta-block">
            <span class="detail-meta-label">消息条数</span>
            <span class="detail-meta-value">${session.messageCount}</span>
          </div>
          <div class="detail-meta-block">
            <span class="detail-meta-label">创建时间</span>
            <span class="detail-meta-value">${formatDateTime(session.createdAt)}</span>
          </div>
          <div class="detail-meta-block">
            <span class="detail-meta-label">更新时间</span>
            <span class="detail-meta-value">${escapeHtml(formatRelativeTime(session.updatedAt))}</span>
          </div>
          <div class="detail-meta-block">
            <span class="detail-meta-label">工作空间</span>
            <span class="detail-meta-value link">${escapeHtml(session.workspacePath || "-")}</span>
          </div>
          <div class="detail-meta-block">
            <span class="detail-meta-label">标签</span>
            <div class="detail-tag-list">${tags || '<span class="detail-meta-value">-</span>'}</div>
          </div>
        </div>

        <div class="detail-source-row">
          <span class="detail-meta-label">源路径</span>
          <div class="detail-source-box">${escapeHtml(session.sourcePath || "-")}</div>
        </div>
        ${capabilityNote}
      </div>

      <div class="chat-pane">
        <div class="chat-divider">
          <div class="chat-divider-line"></div>
          <span class="chat-divider-text">会话开始 • ${formatDateTime(session.createdAt)}</span>
          <div class="chat-divider-line"></div>
        </div>
        <div class="message-list">${messages || '<div class="empty-state">暂无最近消息。</div>'}</div>
      </div>
    </div>
  `;

  bindDetailActions(session);
}

function applyTheme() {
  document.body.classList.remove("theme-dark", "theme-light");
  document.body.classList.add(state.theme === "light" ? "theme-light" : "theme-dark");
  const themeButton = qs("#themeToggleButton");
  if (themeButton) {
    const label = state.theme === "light" ? "切换到深色主题" : "切换到浅色主题";
    themeButton.innerHTML = state.theme === "light" ? themeIcons.light : themeIcons.dark;
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
  }
}

function bindDetailActions(session) {
  qs("#deleteSessionButton")?.addEventListener("click", async () => {
    const confirmed = window.confirm(`确定删除会话“${session.title}”吗？这会删除本地会话记录。`);
    if (!confirmed) {
      return;
    }

    await runAction(async () => {
      await postJson(`/api/sessions/${session.id}/delete`);
      state.selectedIds.delete(session.id);
      await refreshAll();
    });
  });

  qs("#toggleArchiveButton")?.addEventListener("click", async () => {
    const action = session.status === "archived" ? "unarchive" : "archive";
    const confirmed = window.confirm(
      session.status === "archived" ? `确定取消归档“${session.title}”吗？` : `确定归档“${session.title}”吗？`
    );
    if (!confirmed) {
      return;
    }

    await runAction(async () => {
      await postJson(`/api/sessions/${session.id}/${action}`);
      await refreshAll();
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

async function runAction(task) {
  try {
    await task();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
  }
}

async function loadMeta() {
  state.meta = await fetchJson("/api/meta");
  const providerSelect = qs("#providerFilter");

  state.meta.providers.forEach((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    providerSelect.append(option);
  });

  refillWorkspaceOptions();
}

async function loadStats() {
  state.stats = await fetchJson("/api/stats");
  renderUsagePanel();
}

async function loadUsageStats() {
  state.usageStats = await fetchJson(`/api/usage?range=${encodeURIComponent(state.usageRange)}`);
  renderUsagePage();
}

async function loadSessions() {
  state.isLoadingSessions = true;
  renderListSkeleton();

  try {
    state.sessions = await fetchJson(`/api/sessions?${buildQuery()}`);
    if (!state.sessions.some((session) => session.id === state.selectedSessionId)) {
      state.selectedSessionId = state.sessions[0]?.id || null;
      state.selectedSessionDetail = null;
    }

    state.selectedIds.forEach((id) => {
      if (!state.sessions.some((session) => session.id === id)) {
        state.selectedIds.delete(id);
      }
    });

    renderList();
    renderDetail();
    await loadSelectedSessionDetail();
  } finally {
    state.isLoadingSessions = false;
  }
}

async function loadSelectedSessionDetail() {
  if (!state.selectedSessionId) {
    state.selectedSessionDetail = null;
    state.isLoadingDetail = false;
    renderDetail();
    return;
  }

  state.isLoadingDetail = true;
  renderDetail();

  try {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}`);
    if (detail.id !== state.selectedSessionId) {
      return;
    }

    state.selectedSessionDetail = detail;
  } catch (error) {
    if (error.status === 404) {
      return;
    }

    throw error;
  } finally {
    state.isLoadingDetail = false;
    renderDetail();
  }
}

async function refreshAll() {
  await fetchJson("/api/refresh");
  await Promise.all([loadStats(), loadSessions(), state.activeTab === "usage" ? loadUsageStats() : Promise.resolve()]);
}

async function bulkDeleteSelected() {
  const ids = [...state.selectedIds];
  if (!ids.length) {
    window.alert("请先选择至少一条会话。");
    return;
  }

  const unsupportedIds = ids.filter((id) => {
    const session = state.sessions.find((item) => item.id === id);
    return session && !session.capabilities?.canDelete;
  });
  if (unsupportedIds.length) {
    window.alert("选中项中包含当前不支持删除的会话。");
    return;
  }

  const confirmed = window.confirm(`确定删除选中的 ${ids.length} 条会话吗？`);
  if (!confirmed) {
    return;
  }

  for (const id of ids) {
    await postJson(`/api/sessions/${id}/delete`);
  }

  state.selectedIds.clear();
  await refreshAll();
}

async function bulkArchiveVisible() {
  const candidates = state.sessions.filter((session) => session.status !== "archived" && session.capabilities?.canArchive);
  if (!candidates.length) {
    window.alert("当前结果中没有可归档的会话。");
    return;
  }

  const confirmed = window.confirm(`确定将当前结果中的 ${candidates.length} 条会话全部归档吗？`);
  if (!confirmed) {
    return;
  }

  for (const session of candidates) {
    await postJson(`/api/sessions/${session.id}/archive`);
  }

  await refreshAll();
}

function bindControls() {
  applyTheme();

  document.querySelectorAll(".top-nav-link").forEach((button) => {
    button.addEventListener("click", () => {
      switchTab(button.dataset.tab || "dashboard");
    });
  });

  qs("#usageRangeSelect").addEventListener("change", async (event) => {
    state.usageRange = event.target.value;
    document.querySelectorAll(".trend-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.range === state.usageRange);
    });
    await runAction(async () => {
      await loadUsageStats();
    });
  });

  document.querySelectorAll(".trend-tab").forEach((button) => {
    button.addEventListener("click", async () => {
      state.usageRange = button.dataset.range || "30d";
      qs("#usageRangeSelect").value = state.usageRange;
      document.querySelectorAll(".trend-tab").forEach((item) => {
        item.classList.toggle("active", item.dataset.range === state.usageRange);
      });
      await runAction(async () => {
        await loadUsageStats();
      });
    });
  });

  qs("#usageRefreshButton").addEventListener("click", async () => {
    await runAction(async () => {
      await refreshAll();
    });
  });

  qs("#searchInput").addEventListener("input", (event) => {
    state.filters.keyword = event.target.value;
    loadSessions();
  });

  qs("#statusFilter").addEventListener("change", (event) => {
    state.filters.status = event.target.value;
    loadSessions();
  });

  qs("#providerFilter").addEventListener("change", (event) => {
    state.filters.provider = event.target.value;
    refillWorkspaceOptions();
    loadSessions();
  });

  qs("#startDateFilter").addEventListener("change", (event) => {
    state.filters.startDate = event.target.value;
    loadSessions();
  });

  qs("#endDateFilter").addEventListener("change", (event) => {
    state.filters.endDate = event.target.value;
    loadSessions();
  });

  qs("#workspaceFilter").addEventListener("change", (event) => {
    state.filters.workspace = event.target.value;
    loadSessions();
  });

  qs("#linkStatusFilter").addEventListener("change", (event) => {
    state.filters.linkStatus = event.target.value;
    loadSessions();
  });

  qs("#issuesOnlyFilter").addEventListener("change", (event) => {
    state.filters.onlyIssues = event.target.checked;
    loadSessions();
  });

  qs("#refreshButton").addEventListener("click", async () => {
    await runAction(async () => {
      await refreshAll();
    });
  });

  qs("#themeToggleButton").addEventListener("click", () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    localStorage.setItem("ai-session-theme", state.theme);
    applyTheme();
  });

  qs("#deleteSelectedButton").addEventListener("click", async () => {
    await runAction(async () => {
      await bulkDeleteSelected();
    });
  });

  qs("#archiveAllButton").addEventListener("click", async () => {
    await runAction(async () => {
      await bulkArchiveVisible();
    });
  });
}

async function main() {
  bindControls();
  await loadMeta();
  await Promise.all([loadStats(), loadSessions()]);
}

main().catch((error) => {
  qs("#sessionDetail").innerHTML = `<div class="detail-empty">加载失败：${escapeHtml(error.message)}</div>`;
});
