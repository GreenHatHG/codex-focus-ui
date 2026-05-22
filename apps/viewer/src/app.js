const http = require("http");
const path = require("path");

const {
  buildSearchText,
  createCodexRolloutStore,
  loadProjectConfig,
  getProjectMeta,
  resolveCodexRoot,
  truncateText
} = require("../../../packages/shared/src");

const ROOT = path.resolve(__dirname, "../../../");
const CONFIG = loadProjectConfig(ROOT);
const META = getProjectMeta(ROOT);
const PORT = Number(process.env.CODEX_FOCUS_UI_PORT || CONFIG.viewerPort || 3939);
const HOME_SESSION_PAGE_SIZE = 20;

function createStore(rootDir = ROOT, config = CONFIG) {
  return createCodexRolloutStore({
    baseDirs: [resolveCodexRoot(rootDir, config)],
    includeArchived: ((config.codex || {}).includeArchived) !== false,
    projectPathMode: ((config.codex || {}).projectPathMode) || "realpath"
  });
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMarkdown(text) {
  const source = escapeHtml(text || "");
  const blocks = [];

  let output = source.replace(/```([\s\S]*?)```/g, (_, code) => {
    const token = `__CODE_BLOCK_${blocks.length}__`;
    blocks.push(`<pre><code>${code}</code></pre>`);
    return token;
  });

  output = output
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, "<br>");

  return output.replace(/__CODE_BLOCK_(\d+)__/g, (_, index) => blocks[Number(index)] || "");
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseDeleteBody(body) {
  const raw = String(body || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const params = new URLSearchParams(raw);
    return {
      sessionRef: params.get("sessionRef") || ""
    };
  }
}

function getSessionStats(session) {
  const stats = {
    user: 0,
    assistant: 0,
    tool: 0,
    thinking: 0,
    system: 0
  };
  let lastUserText = "";
  const recentTools = [];

  (session.entries || []).forEach((entry) => {
    if (entry.type === "user") {
      stats.user += 1;
      lastUserText = entry.text || lastUserText;
      return;
    }
    if (entry.type === "assistant") {
      stats.assistant += 1;
      return;
    }
    if (entry.filterGroup === "tool") {
      stats.tool += 1;
      if (entry.type === "tool_use") {
        recentTools.unshift({
          name: entry.name,
          input: truncateText(entry.input || "", 100)
        });
        if (recentTools.length > 5) recentTools.pop();
      }
      return;
    }
    if (entry.type === "thinking") {
      stats.thinking += 1;
      return;
    }
    stats.system += 1;
  });

  return {
    ...stats,
    lastUserText: lastUserText || "暂无",
    recentTools
  };
}

function renderTokenBadge(tokenCount) {
  if (!tokenCount || !tokenCount.total) return "";
  const parts = [
    `输入 ${escapeHtml(tokenCount.input)}`,
    `输出 ${escapeHtml(tokenCount.output)}`,
    `总计 ${escapeHtml(tokenCount.total)}`
  ];
  if (tokenCount.reasoning) parts.splice(2, 0, `推理 ${escapeHtml(tokenCount.reasoning)}`);
  return `<span class="token-badge">${parts.join(" / ")}</span>`;
}

function renderProjectOptions(projects, selectedProjectId) {
  if (!projects.length) return '<option value="">(暂无项目)</option>';
  return projects
    .map((project) => {
      const selected = project.projectId === selectedProjectId ? "selected" : "";
      const label = `${project.projectShortLabel} · ${project.sessionCount}`;
      return `<option value="${escapeHtml(project.projectId)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("\n");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function clampPage(page, totalPages) {
  if (!Number.isFinite(page) || page <= 0) return 1;
  if (!Number.isFinite(totalPages) || totalPages <= 0) return 1;
  return Math.min(Math.max(1, Math.floor(page)), totalPages);
}

function makeHomeHref(projectId, page, sessionRef) {
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  if (page && page > 1) params.set("page", String(page));
  if (sessionRef) params.set("session", sessionRef);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function makeSessionPageHref(projectId, sessionRef, page) {
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  if (page && page > 1) params.set("page", String(page));
  if (sessionRef) params.set("session", sessionRef);
  const query = params.toString();
  return query ? `/session?${query}` : "/session";
}

function renderSessionPager(state) {
  if (!state.totalSessions) {
    return '<div class="session-pager"><span class="dim">暂无会话</span></div>';
  }

  const prevHref = state.page > 1
    ? `<a class="btn alt" href="${escapeHtml(makeHomeHref(state.selectedProject.projectId, state.page - 1, ""))}">上一页</a>`
    : '<span class="btn alt disabled">上一页</span>';
  const nextHref = state.page < state.totalPages
    ? `<a class="btn alt" href="${escapeHtml(makeHomeHref(state.selectedProject.projectId, state.page + 1, ""))}">下一页</a>`
    : '<span class="btn alt disabled">下一页</span>';

  return `<div class="session-pager">
    ${prevHref}
    <span class="dim">第 ${escapeHtml(state.page)} / ${escapeHtml(state.totalPages)} 页 · 显示 ${escapeHtml(state.pageStart)}-${escapeHtml(state.pageEnd)} / ${escapeHtml(state.totalSessions)}</span>
    ${nextHref}
  </div>`;
}

function renderSessionCards(sessions, selectedSessionRef, projectId, page) {
  if (!sessions.length) {
    return '<article class="session-card empty-card"><p class="empty">当前项目下暂无会话。</p></article>';
  }

  return sessions.map((session) => {
    const active = session.sessionRef === selectedSessionRef;
    const detailHref = makeSessionPageHref(projectId, session.sessionRef, page);
    const ts = session.lastTs || session.firstTs || "未知时间";
    const cardClass = active ? "session-card active" : "session-card";

    return `<article class="${cardClass}" data-session-card="${escapeHtml(session.sessionRef)}">
      <div class="session-card-topline">
        <span class="pill">${escapeHtml(ts)}</span>
        <span class="dim">${escapeHtml(session.model || "未知模型")}</span>
      </div>
      <h3 class="session-title">${escapeHtml(session.summary || "未命名会话")}</h3>
      <div class="session-metrics">
        <span>消息 ${escapeHtml(session.messageCount)}</span>
        <span>工具 ${escapeHtml(session.toolUseCount)}</span>
        <span>${session.archived ? "归档会话" : "活跃会话"}</span>
      </div>
      <small class="session-ref dim">${escapeHtml(session.sessionRef)}</small>
      <div class="session-actions">
        <a class="btn session-open-btn" href="${escapeHtml(detailHref)}">查看详情</a>
        <a class="btn alt" href="${escapeHtml(detailHref)}" target="_blank" rel="noopener noreferrer">新标签页</a>
      </div>
    </article>`;
  }).join("\n");
}

function getEntryTypeLabel(type) {
  const titleMap = {
    user: "你的提问",
    assistant: "助手回答",
    tool_use: "工具调用",
    tool_result: "工具结果",
    thinking: "思考摘要",
    progress: "过程节点",
    system: "系统记录",
    compact: "上下文压缩"
  };
  return titleMap[type] || type || "未识别记录";
}

function renderEntry(entry, index, lastUserIndex) {
  const title = getEntryTypeLabel(entry.type);
  const isLastUser = entry.type === "user" && index === lastUserIndex;
  const searchable = escapeHtml(buildSearchText(entry)).toLowerCase();
  const anchorId = isLastUser ? ' id="last-user-question"' : "";
  const extraClass = isLastUser ? " last-user-question" : "";

  let body = `<div class="empty">暂无内容</div>`;
  if (entry.type === "user" || entry.type === "assistant") {
    body = `<div class="md-content">${renderMarkdown(entry.text)}</div>`;
  } else if (entry.type === "tool_use") {
    body = `<p><code>${escapeHtml(entry.name)}</code></p>${entry.input ? `<details><summary>查看参数</summary><pre>${escapeHtml(entry.input)}</pre></details>` : ""}`;
  } else if (entry.type === "tool_result") {
    body = `<p><code>${escapeHtml(entry.name || "工具")}</code></p><details><summary>查看输出</summary><pre>${escapeHtml(entry.output || "(无输出)")}</pre></details>`;
  } else if (entry.type === "thinking") {
    body = `<div class="md-content">${renderMarkdown(entry.text)}</div>`;
  } else {
    const details = entry.details ? `<details><summary>查看详情</summary><pre>${escapeHtml(entry.details)}</pre></details>` : "";
    body = `<p>${escapeHtml(entry.text || "")}</p>${details}`;
  }

  return `<article${anchorId} class="card ${escapeHtml(entry.type)}${extraClass}" data-id="${escapeHtml(entry.id)}" data-filter-group="${escapeHtml(entry.filterGroup || entry.type)}" data-search="${searchable}">
    <div class="card-topline">
      <label class="select-toggle"><input type="checkbox" data-select-toggle="${escapeHtml(entry.id)}" /> 勾选</label>
      <div class="card-heading">
        <h3>${escapeHtml(title)}</h3>
        ${entry.type === "assistant" ? renderTokenBadge(entry.tokenCount) : ""}
      </div>
      <button class="bookmark-btn" type="button" data-bookmark-toggle="${escapeHtml(entry.id)}">☆ 书签</button>
    </div>
    ${body}
    <small>${escapeHtml(entry.ts || "")}</small>
  </article>`;
}

function renderRecentTools(items) {
  if (!items.length) return "<p>暂无工具过程。</p>";
  return `<ul class="digest-list">${items.map((item) => `<li><strong>${escapeHtml(item.name || "工具")}</strong> <span class="dim">${escapeHtml(item.input || "")}</span></li>`).join("")}</ul>`;
}

function renderSessionDetail(session) {
  if (!session) {
    return '<article class="card"><p class="empty">未找到会话详情。</p></article>';
  }

  const entries = session.entries || [];
  const stats = getSessionStats(session);
  let lastUserIndex = -1;
  entries.forEach((entry, index) => {
    if (entry.type === "user") lastUserIndex = index;
  });
  const cards = entries.map((entry, index) => renderEntry(entry, index, lastUserIndex)).join("\n");

  return `
    <section class="summary">
      <p><strong>当前会话：</strong>${escapeHtml(session.sessionRef || "未找到会话")}</p>
      <p><strong>项目：</strong>${escapeHtml(session.projectLabel || "未知")}</p>
      <p><strong>模型：</strong>${escapeHtml(session.model || "未知")}</p>
      <p><strong>过程摘要：</strong>提问 ${escapeHtml(stats.user)} 次，助手响应 ${escapeHtml(stats.assistant)} 次，工具过程 ${escapeHtml(stats.tool)} 次，思考摘要 ${escapeHtml(stats.thinking)} 次，系统记录 ${escapeHtml(stats.system)} 次。</p>
      <p><strong>会话摘要：</strong>${escapeHtml(session.summary || "暂无")}</p>
      <p class="last-q"><strong>上一轮提问：</strong>${escapeHtml(stats.lastUserText)}</p>
      <div class="digest">
        <div class="digest-title">最近工具过程</div>
        ${renderRecentTools(stats.recentTools)}
      </div>
    </section>

    <section class="detail-toolbar">
      <button id="session-delete" class="btn danger" ${session.sessionRef ? "" : "disabled"}>删除会话</button>
      <button id="jump-last-question" class="btn">定位上一轮提问</button>
      <button data-mode="all" class="btn alt mode-btn active">全部</button>
      <button data-mode="user" class="btn alt mode-btn">仅提问</button>
      <button data-mode="assistant" class="btn alt mode-btn">仅回答</button>
      <button data-mode="tool" class="btn alt mode-btn">仅工具</button>
      <button data-mode="thinking" class="btn alt mode-btn">仅思考</button>
      <button data-mode="system" class="btn alt mode-btn">仅系统</button>
      <button data-mode="bookmarked" class="btn alt mode-btn">仅书签</button>
      <input id="keyword-input" class="input" type="text" placeholder="搜索关键词（问题 / 回答 / 工具 / 输出）" />
      <button id="clear-search" class="btn alt">清空搜索</button>
      <button id="export-markdown" class="btn">导出 Markdown</button>
      <button id="export-selected-markdown" class="btn alt">导出勾选</button>
      <button id="select-visible-btn" class="btn alt">全选当前可见</button>
      <button id="clear-visible-btn" class="btn alt">取消全选当前可见</button>
    </section>

    <section id="entry-list" class="list">${cards || '<article class="card"><p class="empty">当前会话暂无消息。</p></article>'}</section>
  `;
}

function buildHomeState(store, url) {
  const requestedProjectId = url.searchParams.get("project") || "";
  const requestedSessionRef = url.searchParams.get("session") || "";
  const requestedPage = parsePositiveInt(url.searchParams.get("page") || 1, 1);
  const projects = store.listProjects();

  if (!projects.length) {
    return {
      projects,
      selectedProject: null,
      selectedSessionRef: "",
      visibleSessions: [],
      page: 1,
      pageSize: HOME_SESSION_PAGE_SIZE,
      totalSessions: 0,
      totalPages: 1,
      pageStart: 0,
      pageEnd: 0
    };
  }

  let selectedSession = requestedSessionRef ? store.getSessionMeta(requestedSessionRef) : null;
  let selectedProject = requestedProjectId
    ? projects.find((project) => project.projectId === requestedProjectId) || null
    : null;

  if (selectedSession && !selectedProject) {
    selectedProject = projects.find((project) => project.projectId === selectedSession.projectId) || null;
  }
  if (!selectedProject) selectedProject = projects[0];

  const sessions = store.listSessions(selectedProject.projectId);
  const selectedSessionIndex = selectedSession && selectedSession.projectId === selectedProject.projectId
    ? sessions.findIndex((item) => item.sessionRef === selectedSession.sessionRef)
    : -1;
  const totalSessions = sessions.length;
  const totalPages = Math.max(1, Math.ceil(totalSessions / HOME_SESSION_PAGE_SIZE));
  const page = selectedSessionIndex >= 0
    ? Math.floor(selectedSessionIndex / HOME_SESSION_PAGE_SIZE) + 1
    : clampPage(requestedPage, totalPages);
  const start = (page - 1) * HOME_SESSION_PAGE_SIZE;
  const visibleSessions = sessions.slice(start, start + HOME_SESSION_PAGE_SIZE);

  return {
    projects,
    selectedProject,
    selectedSessionRef: selectedSessionIndex >= 0 ? selectedSession.sessionRef : "",
    visibleSessions,
    page,
    pageSize: HOME_SESSION_PAGE_SIZE,
    totalSessions,
    totalPages,
    pageStart: totalSessions ? start + 1 : 0,
    pageEnd: totalSessions ? Math.min(totalSessions, start + visibleSessions.length) : 0
  };
}

function renderHomePage(store, url, config = CONFIG, meta = META) {
  const state = buildHomeState(store, url);
  const selectedProjectId = state.selectedProject ? state.selectedProject.projectId : "";
  const projectLabel = state.selectedProject ? state.selectedProject.projectLabel : "未知";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>codex-focus-ui 查看器 v${escapeHtml(meta.version)}</title>
  <style>
    body { margin: 0; padding: 24px; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0b0b0b; color: #f3f3f3; }
    .wrap { max-width: 980px; margin: 0 auto 48px; }
    .title { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .hotkeys { color: #9ba4aa; margin-bottom: 12px; font-size: 13px; line-height: 1.6; }
    .warning { margin: 8px 0 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid #5a3b2d; background: #2a1a14; color: #ffd8c8; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; align-items: center; }
    .btn { border: 1px solid #2f6d88; background: #13212b; color: #8edfff; border-radius: 8px; padding: 8px 12px; cursor: pointer; text-decoration: none; }
    .btn.alt { border-color: #3a3a3a; background: #1a1a1a; color: #d0d0d0; }
    .select { border: 1px solid #3a3a3a; background: #141414; color: #f2f2f2; border-radius: 8px; padding: 8px 10px; min-width: 220px; }
    .summary { background: #171717; border: 1px solid #2b2b2b; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .summary p { margin: 6px 0; color: #d2d2d2; line-height: 1.6; }
    .session-browser { background: #111; border: 1px solid #262626; border-radius: 14px; padding: 16px; margin-bottom: 16px; }
    .session-browser-topline { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
    .section-title { margin: 0; font-size: 20px; }
    .session-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .session-card { background: #151515; border: 1px solid #2d2d2d; border-radius: 12px; padding: 14px; display: grid; gap: 10px; }
    .session-card.active { border-color: #69d6ff; box-shadow: inset 0 0 0 1px rgba(105, 214, 255, 0.3); }
    .session-card-topline { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
    .session-title { margin: 0; line-height: 1.55; color: #f2f2f2; font-size: 18px; white-space: normal; word-break: break-word; }
    .session-metrics { display: flex; flex-wrap: wrap; gap: 8px 12px; color: #aeb9bf; font-size: 13px; }
    .session-actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .session-ref { display: block; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .session-pager { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 9px; border: 1px solid #3c5560; color: #b8deef; font-size: 12px; }
    code { background: #232323; padding: 2px 6px; border-radius: 6px; }
    .dim { color: #a0a0a0; }
    .empty { color: #9ba4aa; font-style: italic; }
    @media (max-width: 720px) {
      body { padding: 16px; }
      .session-browser-topline { flex-direction: column; }
      .select { min-width: 0; width: 100%; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="title">codex-focus-ui v${escapeHtml(meta.version)}</section>
    ${config._configError ? `<section class="warning">配置文件异常：${escapeHtml(config._configError)}，当前已回退默认配置。</section>` : ""}
    <section class="hotkeys">快捷键：<code>J</code> 定位上一轮提问，<code>/</code> 聚焦搜索框，<code>T</code>/<code>B</code> 快速到顶部/底部。</section>

    <section class="toolbar">
      <label class="dim" for="project-select">项目:</label>
      <select id="project-select" class="select">${renderProjectOptions(state.projects, selectedProjectId)}</select>
      <span class="dim">会话列表按最近时间排序，每页 ${escapeHtml(state.pageSize)} 条。</span>
      <a class="btn alt" href="/search">全局搜索</a>
    </section>

    <section class="summary">
      <p><strong>当前项目：</strong>${escapeHtml(projectLabel)}</p>
      <p><strong>会话总数：</strong>${escapeHtml(state.totalSessions)}</p>
      <p><strong>当前分页：</strong>第 ${escapeHtml(state.page)} / ${escapeHtml(state.totalPages)} 页，当前显示 ${escapeHtml(state.pageStart)}-${escapeHtml(state.pageEnd)} 条摘要。</p>
    </section>

    <section class="session-browser">
      <div class="session-browser-topline">
        <h2 class="section-title">会话列表</h2>
        ${renderSessionPager(state)}
      </div>
      <section id="session-grid" class="session-grid">${renderSessionCards(state.visibleSessions, state.selectedSessionRef, selectedProjectId, state.page)}</section>
    </section>
  </main>

  <script>
    (() => {
      const projectSelect = document.getElementById('project-select');
      projectSelect?.addEventListener('change', () => {
        const params = new URLSearchParams(window.location.search);
        const value = projectSelect.value;
        if (value) params.set('project', value);
        else params.delete('project');
        params.delete('session');
        params.delete('page');
        window.location.href = '/?' + params.toString();
      });
    })();
  </script>
</body>
</html>`;
}

function renderSessionPage(session, url, config = CONFIG, meta = META) {
  const requestedProjectId = url.searchParams.get("project") || session.projectId || "";
  const requestedPage = parsePositiveInt(url.searchParams.get("page") || 1, 1);
  const backHref = makeHomeHref(requestedProjectId, requestedPage, session.sessionRef);
  const detailHtml = renderSessionDetail(session);
  const stats = getSessionStats(session);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(session.summary || "会话详情")} · codex-focus-ui v${escapeHtml(meta.version)}</title>
  <style>
    body { margin: 0; padding: 24px; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0b0b0b; color: #f3f3f3; }
    .wrap { max-width: 980px; margin: 0 auto 120px; }
    .nav { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
    .nav-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .title { font-size: 28px; font-weight: 700; margin: 0 0 8px; line-height: 1.35; }
    .warning { margin: 8px 0 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid #5a3b2d; background: #2a1a14; color: #ffd8c8; }
    .btn { border: 1px solid #2f6d88; background: #13212b; color: #8edfff; border-radius: 8px; padding: 8px 12px; cursor: pointer; text-decoration: none; }
    .btn.alt { border-color: #3a3a3a; background: #1a1a1a; color: #d0d0d0; }
    .btn.danger { border-color: #7a3a3a; background: #2a1212; color: #ffb7b7; }
    .btn.active { border-color: #69d6ff; color: #d4f2ff; box-shadow: inset 0 0 0 1px rgba(105, 214, 255, 0.3); }
    .input { border: 1px solid #3a3a3a; background: #141414; color: #f2f2f2; border-radius: 8px; padding: 8px 10px; min-width: 220px; }
    .summary { background: #171717; border: 1px solid #2b2b2b; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .summary p { margin: 6px 0; color: #d2d2d2; line-height: 1.6; }
    .last-q { color: #6fd3ff; font-weight: 700; }
    .digest { margin-top: 10px; background: #111; border: 1px solid #303030; border-radius: 10px; padding: 10px; }
    .digest-title { font-size: 13px; margin-bottom: 8px; color: #cfd9df; }
    .digest-list { margin: 0; padding-left: 18px; }
    .digest-list li { margin: 5px 0; }
    .detail-toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; align-items: center; }
    .list { display: grid; gap: 12px; }
    .card { position: relative; background: #151515; border: 1px solid #2d2d2d; border-radius: 12px; padding: 14px; }
    .card-topline { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .card-heading { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
    .card h3 { margin: 0; font-size: 16px; }
    .card p { margin: 0 0 8px 0; line-height: 1.5; }
    .card small { color: #9a9a9a; }
    .md-content { line-height: 1.65; margin-bottom: 8px; color: #e7e7e7; }
    .md-content pre, pre { background: #101010; border: 1px solid #303030; border-radius: 8px; padding: 10px; white-space: pre-wrap; word-break: break-word; }
    .md-content a { color: #7fd7ff; text-decoration: underline; }
    details { background: #111; border: 1px solid #303030; border-radius: 8px; padding: 8px; margin-top: 8px; }
    summary { cursor: pointer; }
    code { background: #232323; padding: 2px 6px; border-radius: 6px; }
    .dim { color: #a0a0a0; line-height: 1.6; }
    .user { border-color: #2f6d88; box-shadow: inset 0 0 0 1px rgba(111, 211, 255, 0.25); }
    .assistant { border-color: #434343; }
    .tool_use, .tool_result { border-color: #4b4b4b; }
    .thinking { border-color: #4c5860; }
    .progress, .system, .compact { border-color: #3c3c3c; }
    .bookmark-btn { border: 1px solid #454545; background: #1f1f1f; color: #dadada; border-radius: 999px; padding: 2px 8px; cursor: pointer; font-size: 12px; margin-left: auto; flex-shrink: 0; }
    .bookmark-btn.active { border-color: #dcb95a; color: #ffd877; background: #2a2410; }
    .select-toggle { font-size: 12px; color: #cfcfcf; display: inline-flex; gap: 6px; align-items: center; user-select: none; white-space: nowrap; flex-shrink: 0; }
    .selected { border-color: #4f9b5d; box-shadow: inset 0 0 0 1px rgba(112, 211, 132, 0.35); }
    .bookmarked { border-color: #7b6730; box-shadow: inset 0 0 0 1px rgba(220, 185, 90, 0.35); }
    .last-user-question { border-color: #69d6ff; box-shadow: inset 0 0 0 1px rgba(105, 214, 255, 0.55), 0 0 0 1px rgba(105, 214, 255, 0.15); }
    .token-badge { color: #a8bcc6; font-size: 11px; border: 1px solid #33444c; border-radius: 999px; padding: 3px 8px; background: #111a1f; }
    .empty { color: #9ba4aa; font-style: italic; }
    .hidden { display: none !important; }
    .floating-last-question { position: fixed; left: 16px; right: 16px; bottom: 12px; z-index: 999; background: rgba(17, 17, 17, 0.96); border: 1px solid #2f6d88; border-radius: 12px; padding: 10px 12px; display: flex; gap: 10px; align-items: center; }
    .floating-scroll-nav { position: fixed; right: 16px; bottom: 84px; z-index: 1000; display: flex; gap: 8px; }
    .mini-btn { border: 1px solid #3f3f3f; background: rgba(22, 22, 22, 0.95); color: #d8d8d8; border-radius: 8px; padding: 7px 10px; cursor: pointer; }
    .floating-last-question .label { color: #9fdfff; font-size: 12px; }
    .floating-last-question .text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #eaf7ff; }
    @media (max-width: 720px) {
      body { padding: 16px; }
      .wrap { margin-bottom: 132px; }
      .card-topline { align-items: flex-start; flex-wrap: wrap; }
      .floating-last-question { left: 10px; right: 10px; }
      .floating-scroll-nav { right: 10px; }
      .input { min-width: 0; width: 100%; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="nav">
      <a class="btn alt" href="${escapeHtml(backHref)}">返回会话列表</a>
      <div class="nav-actions">
        <a class="btn alt" href="/search">全局搜索</a>
        <span class="dim">codex-focus-ui v${escapeHtml(meta.version)}</span>
      </div>
    </section>
    ${config._configError ? `<section class="warning">配置文件异常：${escapeHtml(config._configError)}，当前已回退默认配置。</section>` : ""}
    <h1 class="title">${escapeHtml(session.summary || "会话详情")}</h1>

    ${detailHtml}
  </main>

  <section class="floating-scroll-nav" aria-label="页面快速滚动">
    <button id="scroll-top" class="mini-btn" type="button">到顶部</button>
    <button id="scroll-bottom" class="mini-btn" type="button">到底部</button>
  </section>

  <section id="floating-last-question" class="floating-last-question hidden">
    <span class="label">上一问</span>
    <span id="floating-last-question-text" class="text">暂无</span>
    <button id="floating-jump" class="mini-btn" type="button">定位</button>
    <button id="floating-copy" class="mini-btn" type="button">复制</button>
  </section>

  <script>
    (() => {
      const list = document.getElementById('entry-list');
      const modeBtns = Array.from(document.querySelectorAll('.mode-btn'));
      const keywordInput = document.getElementById('keyword-input');
      const clearSearchBtn = document.getElementById('clear-search');
      const deleteBtn = document.getElementById('session-delete');
      const jumpBtn = document.getElementById('jump-last-question');
      const exportBtn = document.getElementById('export-markdown');
      const exportSelectedBtn = document.getElementById('export-selected-markdown');
      const selectVisibleBtn = document.getElementById('select-visible-btn');
      const clearVisibleBtn = document.getElementById('clear-visible-btn');
      const floatingBar = document.getElementById('floating-last-question');
      const floatingText = document.getElementById('floating-last-question-text');
      const floatingJumpBtn = document.getElementById('floating-jump');
      const floatingCopyBtn = document.getElementById('floating-copy');
      const scrollTopBtn = document.getElementById('scroll-top');
      const scrollBottomBtn = document.getElementById('scroll-bottom');

      const sessionRef = ${JSON.stringify(session.sessionRef || "")};
      const projectId = ${JSON.stringify(requestedProjectId || "")};
      const page = ${JSON.stringify(requestedPage)};
      const lastQuestionText = ${JSON.stringify(stats.lastUserText || "")};
      const bookmarkStorageKey = 'codex-focus-ui:bookmarks:' + sessionRef;
      const selectedStorageKey = 'codex-focus-ui:selected:' + sessionRef;
      const bookmarks = new Set(JSON.parse(localStorage.getItem(bookmarkStorageKey) || '[]'));
      const selected = new Set(JSON.parse(localStorage.getItem(selectedStorageKey) || '[]'));

      let mode = 'all';
      let keyword = '';

      const updateFloatingBar = () => {
        const text = String(lastQuestionText || '').trim();
        floatingBar.classList.toggle('hidden', !text);
        floatingText.textContent = text || '暂无';
      };
      const saveBookmarks = () => {
        localStorage.setItem(bookmarkStorageKey, JSON.stringify(Array.from(bookmarks)));
      };
      const saveSelected = () => {
        localStorage.setItem(selectedStorageKey, JSON.stringify(Array.from(selected)));
      };
      const syncBookmarkUI = () => {
        list?.querySelectorAll('[data-id]').forEach((card) => {
          const id = card.getAttribute('data-id');
          const marked = bookmarks.has(id);
          card.classList.toggle('bookmarked', marked);
          const btn = card.querySelector('[data-bookmark-toggle]');
          if (btn) {
            btn.classList.toggle('active', marked);
            btn.textContent = marked ? '★ 书签' : '☆ 书签';
          }
        });
      };
      const syncSelectedUI = () => {
        list?.querySelectorAll('[data-id]').forEach((card) => {
          const id = card.getAttribute('data-id');
          const marked = selected.has(id);
          card.classList.toggle('selected', marked);
          const box = card.querySelector('[data-select-toggle]');
          if (box) box.checked = marked;
        });
      };
      const getVisibleIds = () => {
        return Array.from(list?.querySelectorAll('[data-id]') || [])
          .filter((card) => !card.classList.contains('hidden'))
          .map((card) => card.getAttribute('data-id'))
          .filter(Boolean);
      };
      const applyFilter = () => {
        list?.querySelectorAll('[data-filter-group]').forEach((card) => {
          const group = card.getAttribute('data-filter-group');
          const id = card.getAttribute('data-id');
          const search = (card.getAttribute('data-search') || '').toLowerCase();
          const modeHit = mode === 'all' || group === mode || (mode === 'bookmarked' && bookmarks.has(id));
          const keywordHit = !keyword || search.includes(keyword);
          card.classList.toggle('hidden', !(modeHit && keywordHit));
        });
        modeBtns.forEach((btn) => {
          btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
        });
      };
      const jumpLastQuestion = () => {
        const target = document.getElementById('last-user-question');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      const copyLastQuestion = async () => {
        const text = String(lastQuestionText || '').trim();
        if (!text) return;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            floatingCopyBtn.textContent = '已复制';
            setTimeout(() => { floatingCopyBtn.textContent = '复制'; }, 1200);
            return;
          }
        } catch (_) {}
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        floatingCopyBtn.textContent = '已复制';
        setTimeout(() => { floatingCopyBtn.textContent = '复制'; }, 1200);
      };
      const buildHomeHref = (session) => {
        const params = new URLSearchParams();
        if (projectId) params.set('project', projectId);
        if (page > 1) params.set('page', String(page));
        if (session) params.set('session', session);
        const query = params.toString();
        return query ? '/?' + query : '/';
      };
      const buildSessionHref = (session) => {
        const params = new URLSearchParams();
        if (projectId) params.set('project', projectId);
        if (page > 1) params.set('page', String(page));
        if (session) params.set('session', session);
        const query = params.toString();
        return query ? '/session?' + query : '/session';
      };

      deleteBtn?.addEventListener('click', async () => {
        if (!sessionRef) return;
        const ok = confirm('确认删除真实 Codex rollout 文件？\\n\\n此操作会直接删除磁盘上的 rollout 文件，无法恢复。\\n\\n' + sessionRef);
        if (!ok) return;
        const response = await fetch('/api/session/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionRef })
        });
        const json = await response.json();
        if (!json.ok) {
          alert('删除失败：' + (json.error || '未知错误'));
          return;
        }
        if (json.nextSessionRef) {
          window.location.href = buildSessionHref(json.nextSessionRef);
          return;
        }
        window.location.href = buildHomeHref('');
      });
      jumpBtn?.addEventListener('click', jumpLastQuestion);
      floatingJumpBtn?.addEventListener('click', jumpLastQuestion);
      floatingCopyBtn?.addEventListener('click', copyLastQuestion);
      scrollTopBtn?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
      scrollBottomBtn?.addEventListener('click', () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));

      modeBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          mode = btn.getAttribute('data-mode') || 'all';
          applyFilter();
        });
      });
      keywordInput?.addEventListener('input', (event) => {
        keyword = String(event.target.value || '').trim().toLowerCase();
        applyFilter();
      });
      clearSearchBtn?.addEventListener('click', () => {
        keyword = '';
        if (keywordInput) keywordInput.value = '';
        applyFilter();
      });
      exportBtn?.addEventListener('click', () => {
        if (!sessionRef) return;
        const params = new URLSearchParams({
          session: sessionRef,
          mode,
          keyword,
          bookmarks: Array.from(bookmarks).join(',')
        });
        window.location.href = '/export.md?' + params.toString();
      });
      exportSelectedBtn?.addEventListener('click', () => {
        if (!selected.size || !sessionRef) {
          alert('请先勾选至少一条记录再导出。');
          return;
        }
        const params = new URLSearchParams({
          session: sessionRef,
          mode,
          keyword,
          bookmarks: Array.from(bookmarks).join(','),
          selected: Array.from(selected).join(','),
          selectedOnly: '1'
        });
        window.location.href = '/export.md?' + params.toString();
      });
      selectVisibleBtn?.addEventListener('click', () => {
        getVisibleIds().forEach((id) => selected.add(id));
        saveSelected();
        syncSelectedUI();
      });
      clearVisibleBtn?.addEventListener('click', () => {
        getVisibleIds().forEach((id) => selected.delete(id));
        saveSelected();
        syncSelectedUI();
      });
      list?.querySelectorAll('[data-bookmark-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-bookmark-toggle');
          if (!id) return;
          if (bookmarks.has(id)) bookmarks.delete(id);
          else bookmarks.add(id);
          saveBookmarks();
          syncBookmarkUI();
          applyFilter();
        });
      });
      list?.querySelectorAll('[data-select-toggle]').forEach((box) => {
        box.addEventListener('change', () => {
          const id = box.getAttribute('data-select-toggle');
          if (!id) return;
          if (box.checked) selected.add(id);
          else selected.delete(id);
          saveSelected();
          syncSelectedUI();
        });
      });
      document.addEventListener('keydown', (event) => {
        const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
        const typing = tag === 'input' || tag === 'textarea';
        if (!typing && event.key.toLowerCase() === 'j') {
          event.preventDefault();
          jumpLastQuestion();
        } else if (!typing && event.key.toLowerCase() === 't') {
          event.preventDefault();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (!typing && event.key.toLowerCase() === 'b') {
          event.preventDefault();
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        } else if (!typing && event.key === '/') {
          event.preventDefault();
          keywordInput?.focus();
        }
      });

      updateFloatingBar();
      syncBookmarkUI();
      syncSelectedUI();
      applyFilter();
    })();
  </script>
</body>
</html>`;
}

function renderSearchResults(results) {
  if (!results.length) {
    return '<article class="result-card"><p class="empty">没有匹配的会话。</p></article>';
  }
  return results.map((result) => {
    const href = makeSessionPageHref(result.projectId, result.sessionRef);
    return `<article class="result-card">
      <div class="result-topline">
        <span class="pill">${escapeHtml(result.projectShortLabel)}</span>
        <span class="dim">${escapeHtml(result.lastTs || "")}</span>
      </div>
      <h3><a href="${href}">${escapeHtml(result.summary || "（无摘要）")}</a></h3>
      <p class="dim">项目：${escapeHtml(result.projectLabel)}</p>
      <p>${escapeHtml(result.snippet)}</p>
      <code>${escapeHtml(result.sessionRef)}</code>
    </article>`;
  }).join("\n");
}

function renderSearchPage(store, url, meta = META) {
  const query = url.searchParams.get("q") || "";
  const projectId = url.searchParams.get("project") || "";
  const limit = Number(url.searchParams.get("limit") || 20);
  const projects = store.listProjects();
  const results = query ? store.search(query, projectId, limit) : [];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>codex-focus-ui 全局搜索 v${escapeHtml(meta.version)}</title>
  <style>
    body { margin: 0; padding: 24px; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0b0b0b; color: #f3f3f3; }
    .wrap { max-width: 980px; margin: 0 auto 48px; }
    .title { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .subtitle, .dim { color: #9ba4aa; line-height: 1.6; }
    .toolbar { display: grid; gap: 10px; margin: 14px 0 16px; padding: 16px; background: #171717; border: 1px solid #2b2b2b; border-radius: 12px; }
    .search-grid { display: grid; gap: 10px; grid-template-columns: 1.8fr 1fr auto; }
    .input, .select { border: 1px solid #3a3a3a; background: #141414; color: #f2f2f2; border-radius: 8px; padding: 8px 10px; }
    .btn { border: 1px solid #2f6d88; background: #13212b; color: #8edfff; border-radius: 8px; padding: 8px 12px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
    .btn.alt { border-color: #3a3a3a; background: #1a1a1a; color: #d0d0d0; }
    .nav { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; }
    .results { display: grid; gap: 12px; }
    .result-card { background: #151515; border: 1px solid #2d2d2d; border-radius: 12px; padding: 14px; }
    .result-card h3 { margin: 8px 0; font-size: 18px; }
    .result-card a { color: #7fd7ff; text-decoration: underline; }
    .result-card p { margin: 6px 0; line-height: 1.6; }
    .result-topline { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 9px; border: 1px solid #3c5560; color: #b8deef; font-size: 12px; }
    code { background: #232323; padding: 2px 6px; border-radius: 6px; }
    .empty { color: #9ba4aa; font-style: italic; }
    @media (max-width: 720px) {
      body { padding: 16px; }
      .search-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="nav">
      <a class="btn alt" href="/">返回会话页</a>
      <span class="dim">codex-focus-ui v${escapeHtml(meta.version)}</span>
    </section>
    <section class="title">全局搜索</section>
    <section class="subtitle">按关键词搜索所有项目下的 rollout。结果会按最近活跃的会话排序，并直接跳回对应会话页。</section>
    <form class="toolbar" method="get" action="/search">
      <div class="search-grid">
        <input class="input" type="text" name="q" value="${escapeHtml(query)}" placeholder="搜索提问、回答、工具调用、输出..." />
        <select class="select" name="project">
          <option value="">全部项目</option>
          ${projects.map((project) => `<option value="${escapeHtml(project.projectId)}" ${project.projectId === projectId ? "selected" : ""}>${escapeHtml(project.projectShortLabel)}</option>`).join("\n")}
        </select>
        <button class="btn" type="submit">搜索</button>
      </div>
      <input type="hidden" name="limit" value="${escapeHtml(limit)}" />
    </form>
    <section class="results">${query ? renderSearchResults(results) : '<article class="result-card"><p class="empty">输入关键词后，会在所有已扫描的 rollout 中搜索。</p></article>'}</section>
  </main>
</body>
</html>`;
}

function filterEntriesForExport(entries, mode, keyword, bookmarksSet, selectedSet, selectedOnly) {
  const query = String(keyword || "").trim().toLowerCase();
  return (entries || []).filter((entry) => {
    const id = entry.id;
    if (selectedOnly) return selectedSet.has(id);
    const modeHit = mode === "all" || entry.filterGroup === mode || entry.type === mode || (mode === "bookmarked" && bookmarksSet.has(id));
    const keywordHit = !query || buildSearchText(entry).toLowerCase().includes(query);
    return modeHit && keywordHit;
  });
}

function renderExportMarkdown(session, mode, keyword, bookmarksCsv, selectedCsv, selectedOnly) {
  const bookmarksSet = new Set(String(bookmarksCsv || "").split(",").map((item) => item.trim()).filter(Boolean));
  const selectedSet = new Set(String(selectedCsv || "").split(",").map((item) => item.trim()).filter(Boolean));
  const entries = filterEntriesForExport(session.entries || [], mode, keyword, bookmarksSet, selectedSet, selectedOnly);
  const stats = getSessionStats({ entries });

  const lines = [
    "# codex-focus-ui 导出清单",
    "",
    `- 会话引用: ${session.sessionRef}`,
    `- 项目: ${session.projectLabel}`,
    `- 模型: ${session.model || "未知"}`,
    `- 导出时间: ${new Date().toISOString()}`,
    `- 过滤模式: ${mode}`,
    `- 关键词: ${keyword || "(无)"}`,
    `- 条目数量: ${entries.length}`,
    `- 摘要: 提问 ${stats.user} / 回答 ${stats.assistant} / 工具 ${stats.tool} / 思考 ${stats.thinking} / 系统 ${stats.system}`,
    ""
  ];

  entries.forEach((entry, index) => {
    lines.push(`## ${index + 1}. ${getEntryTypeLabel(entry.type)}`);
    lines.push("");
    lines.push(`- 时间: ${entry.ts || ""}`);
    if (entry.name) lines.push(`- 名称: ${entry.name}`);
    if (entry.tokenCount && entry.tokenCount.total) {
      lines.push(`- Token: 输入 ${entry.tokenCount.input} / 输出 ${entry.tokenCount.output} / 总计 ${entry.tokenCount.total}`);
    }
    if (entry.text) {
      lines.push("- 内容:");
      lines.push("```markdown");
      lines.push(String(entry.text));
      lines.push("```");
    }
    if (entry.input) {
      lines.push("- 输入参数:");
      lines.push("```text");
      lines.push(String(entry.input).slice(0, 8000));
      lines.push("```");
    }
    if (entry.output) {
      lines.push("- 输出结果:");
      lines.push("```text");
      lines.push(String(entry.output).slice(0, 8000));
      lines.push("```");
    }
    if (entry.details) {
      lines.push("- 详情:");
      lines.push("```text");
      lines.push(String(entry.details).slice(0, 8000));
      lines.push("```");
    }
    lines.push("");
  });

  return lines.join("\n");
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function createViewerServer(options = {}) {
  const store = options.store || createStore(options.rootDir || ROOT, options.config || CONFIG);
  const config = options.config || CONFIG;
  const meta = options.meta || META;
  const port = options.port != null ? options.port : PORT;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderHomePage(store, url, config, meta));
        return;
      }

      if (req.method === "GET" && url.pathname === "/session") {
        const sessionRef = url.searchParams.get("session") || "";
        const session = sessionRef ? store.getSession(sessionRef) : null;
        if (!session) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("session not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderSessionPage(session, url, config, meta));
        return;
      }

      if (req.method === "GET" && url.pathname === "/search") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderSearchPage(store, url, meta));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/projects") {
        writeJson(res, 200, {
          projects: store.listProjects()
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const projectId = url.searchParams.get("project") || "";
        const allSessions = store.listSessions(projectId);
        const hasPaging = url.searchParams.has("page") || url.searchParams.has("pageSize");
        let sessions = allSessions;
        let page = 1;
        let pageSize = 0;

        if (hasPaging) {
          pageSize = parsePositiveInt(url.searchParams.get("pageSize") || HOME_SESSION_PAGE_SIZE, HOME_SESSION_PAGE_SIZE);
          const totalPages = Math.max(1, Math.ceil(allSessions.length / pageSize));
          page = clampPage(parsePositiveInt(url.searchParams.get("page") || 1, 1), totalPages);
          const start = (page - 1) * pageSize;
          sessions = allSessions.slice(start, start + pageSize);
        } else {
          const limit = Number(url.searchParams.get("limit") || (projectId ? 0 : 20));
          if (Number.isFinite(limit) && limit > 0) {
            sessions = allSessions.slice(0, limit);
            pageSize = limit;
          } else {
            pageSize = allSessions.length || HOME_SESSION_PAGE_SIZE;
          }
        }

        writeJson(res, 200, {
          projectId,
          page,
          pageSize,
          totalSessions: allSessions.length,
          totalPages: Math.max(1, Math.ceil(allSessions.length / Math.max(pageSize, 1))),
          sessions
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/messages") {
        const sessionRef = url.searchParams.get("session") || "";
        const view = url.searchParams.get("view") || "";
        const session = sessionRef ? store.getSession(sessionRef) : null;
        if (!session) {
          writeJson(res, 404, { error: "session not found" });
          return;
        }
        const stats = getSessionStats(session);
        const payload = {
          session: {
            sessionRef: session.sessionRef,
            summary: session.summary,
            model: session.model,
            projectId: session.projectId,
            projectLabel: session.projectLabel,
            lastTs: session.lastTs,
            firstTs: session.firstTs
          },
          stats,
          html: renderSessionDetail(session)
        };
        if (view !== "rendered") payload.messages = session.entries;
        writeJson(res, 200, payload);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/search") {
        const query = url.searchParams.get("q") || "";
        const projectId = url.searchParams.get("project") || "";
        const limit = Number(url.searchParams.get("limit") || 20);
        writeJson(res, 200, {
          query,
          projectId,
          results: store.search(query, projectId, limit)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/session/delete") {
        const body = parseDeleteBody(await readRequestBody(req));
        const result = store.deleteSession(body.sessionRef || "");
        writeJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === "GET" && url.pathname === "/export.md") {
        const sessionRef = url.searchParams.get("session") || "";
        const session = sessionRef ? store.getSession(sessionRef) : null;
        if (!session) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("session not found");
          return;
        }
        const mode = url.searchParams.get("mode") || "all";
        const keyword = url.searchParams.get("keyword") || "";
        const bookmarks = url.searchParams.get("bookmarks") || "";
        const selected = url.searchParams.get("selected") || "";
        const selectedOnly = url.searchParams.get("selectedOnly") === "1";
        const body = renderExportMarkdown(session, mode, keyword, bookmarks, selected, selectedOnly);
        const filename = `codex-focus-${path.basename(session.sessionRef).replace(/\.jsonl$/, "")}.md`;
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename=${filename}`
        });
        res.end(body);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } catch (error) {
      console.error(`[codex-focus-ui viewer] request failed: ${error.message}`);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Viewer internal error. Check terminal logs.");
    }
  });

  return server;
}

function startViewerServer(port = PORT, options = {}) {
  const server = createViewerServer({ ...options, port });
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

module.exports = {
  CONFIG,
  META,
  PORT,
  ROOT,
  createStore,
  createViewerServer,
  filterEntriesForExport,
  renderExportMarkdown,
  renderHomePage,
  renderSearchPage,
  startViewerServer
};
