const fs = require("fs");
const path = require("path");

const META_CACHE_TTL_MS = 5000;
const PARSE_CACHE_LIMIT = 24;

const META_CACHE = new Map();
const PARSE_CACHE = new Map();

const TOOL_USE_TYPES = new Set([
  "function_call",
  "local_shell_call",
  "custom_tool_call",
  "web_search_call"
]);

const TOOL_RESULT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output"
]);

const PROGRESS_EVENT_TYPES = new Set([
  "task_started",
  "task_complete",
  "turn_aborted",
  "context_compacted",
  "patch_apply_end",
  "web_search_end",
  "mcp_tool_call_end",
  "item_completed"
]);

function clearCodexCaches() {
  META_CACHE.clear();
  PARSE_CACHE.clear();
}

function toPosixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function basenameAnyPath(value) {
  const parts = String(value || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(value || "");
}

function truncateText(value, limit = 160) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function stripPromptWrapperBlocks(value) {
  let text = String(value || "").trim();
  [
    "environment_context",
    "turn_aborted"
  ].forEach((tag) => {
    text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  });
  return text;
}

const SESSION_TITLE_NOISE_LINE_PATTERNS = [
  /^<environment_context\b/i,
  /^<\/environment_context>/i,
  /^<turn_aborted\b/i,
  /^<\/turn_aborted>/i,
  /^<cwd>.*<\/cwd>$/i,
  /^<shell>.*<\/shell>$/i,
  /^<current_date>.*<\/current_date>$/i,
  /^<timezone>.*<\/timezone>$/i,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z(?:\s+\S+)?$/i,
  /^消息\s+\d+/,
  /^(sessions|archived_sessions)\//,
  /^直达链接$/,
  /^(活跃会话|归档会话)$/
];

function normalizeSessionTitleLine(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (SESSION_TITLE_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(text))) return "";

  text = text
    .replace(/<\/?(?:environment_context|turn_aborted|cwd|shell|current_date|timezone)[^>]*>/gi, " ")
    .replace(/(?:^|\s)(?:sessions|archived_sessions)\/\S+/gi, " ")
    .replace(/\/data\/data\/\S+/g, " ")
    .replace(/\b(?:cwd|shell|current_date|timezone|environment_context|turn_aborted)\b/gi, " ")
    .replace(/\b消息\s*\d+\b/gi, " ")
    .replace(/\b工具\s*\d+\b/gi, " ")
    .replace(/\b(?:活跃会话|归档会话|直达链接)\b/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (/^[\W_]+$/.test(text)) return "";
  return text;
}

function extractSessionTitle(value, limit = 160) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const candidate = stripPromptWrapperBlocks(raw)
    .split(/\r?\n/)
    .map((line) => normalizeSessionTitleLine(line))
    .filter(Boolean)
    .join(" ");

  if (!candidate) return "";
  return truncateText(candidate, limit);
}

function toDisplayPath(meta) {
  return meta.cwdResolved || meta.cwdRaw || "unknown";
}

function toProjectShortLabel(projectId) {
  if (!projectId || projectId === "unknown") return "unknown";
  return basenameAnyPath(projectId);
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJsonl(filePath, keepBroken = false) {
  if (!fs.existsSync(filePath)) return [];

  const rows = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line) return;
    const parsed = safeJsonParse(line);
    if (parsed) {
      rows.push(parsed);
      return;
    }
    if (keepBroken) {
      rows.push({
        type: "broken",
        timestamp: null,
        payload: {
          line,
          lineNumber: index + 1
        }
      });
    }
  });
  return rows;
}

function walkRolloutFiles(dirPath, area, rootDir) {
  if (!fs.existsSync(dirPath)) return [];

  const files = [];
  const stack = [dirPath];

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        return;
      }
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) return;

      const stats = fs.statSync(fullPath);
      files.push({
        rootDir,
        area,
        absolutePath: fullPath,
        sessionRef: toPosixPath(path.relative(rootDir, fullPath)),
        mtimeMs: stats.mtimeMs,
        size: stats.size
      });
    });
  }

  return files;
}

function buildScanSignature(files) {
  let latestMtime = 0;
  files.forEach((file) => {
    if (file.mtimeMs > latestMtime) latestMtime = file.mtimeMs;
  });
  return `${files.length}:${latestMtime}`;
}

function getSortableTimestamp(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

function getSessionRecencyMs(item) {
  const tsMs = Math.max(getSortableTimestamp(item.lastTs), getSortableTimestamp(item.firstTs));
  if (tsMs > 0) return tsMs;
  return item.mtimeMs || 0;
}

function sortByRecentSession(items) {
  return items.slice().sort((left, right) => {
    const rightMs = getSessionRecencyMs(right);
    const leftMs = getSessionRecencyMs(left);
    if (rightMs !== leftMs) return rightMs - leftMs;
    return String(left.sessionRef).localeCompare(String(right.sessionRef));
  });
}

function getRowTimestamp(row) {
  if (!row || typeof row !== "object") return "";
  if (row.timestamp) return String(row.timestamp);
  if (row.payload && row.payload.timestamp) return String(row.payload.timestamp);
  return "";
}

function extractContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) {
    if (typeof content === "object" && content.text) return String(content.text).trim();
    return "";
  }

  const parts = [];
  content.forEach((item) => {
    if (item == null) return;
    if (typeof item === "string") {
      parts.push(item);
      return;
    }
    if (typeof item === "object") {
      if (item.text) {
        parts.push(String(item.text));
        return;
      }
      if (item.content) {
        parts.push(extractContentText(item.content));
      }
    }
  });

  return parts.join("\n\n").trim();
}

function extractReasoningSummary(summaryItems) {
  if (!Array.isArray(summaryItems) || !summaryItems.length) return "";
  const parts = summaryItems
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (item.text) return String(item.text).trim();
      if (item.summary_text) return String(item.summary_text).trim();
      return "";
    })
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function normalizeProjectPath(cwdRaw, projectPathMode = "realpath") {
  const raw = String(cwdRaw || "").trim();
  if (!raw) {
    return {
      cwdRaw: "",
      cwdResolved: "",
      projectId: "unknown"
    };
  }

  if (projectPathMode === "realpath") {
    try {
      const resolved = fs.realpathSync.native ? fs.realpathSync.native(raw) : fs.realpathSync(raw);
      return {
        cwdRaw: raw,
        cwdResolved: resolved,
        projectId: resolved
      };
    } catch {
      return {
        cwdRaw: raw,
        cwdResolved: "",
        projectId: raw
      };
    }
  }

  return {
    cwdRaw: raw,
    cwdResolved: raw,
    projectId: raw
  };
}

function scanRollouts(baseDirs, options = {}) {
  const includeArchived = options.includeArchived !== false;
  const results = [];

  (baseDirs || []).forEach((baseDir) => {
    const rootDir = path.resolve(baseDir);
    const sessionsDir = path.join(rootDir, "sessions");
    const archivedDir = path.join(rootDir, "archived_sessions");
    results.push(...walkRolloutFiles(sessionsDir, "sessions", rootDir));
    if (includeArchived) {
      results.push(...walkRolloutFiles(archivedDir, "archived_sessions", rootDir));
    }
  });

  results.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
    return String(left.sessionRef).localeCompare(String(right.sessionRef));
  });
  return results;
}

function extractSessionMeta(fileRecord, options = {}) {
  const rows = readJsonl(fileRecord.absolutePath, false);

  let sessionId = path.basename(fileRecord.absolutePath).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
  let cwdRaw = "";
  let model = "";
  let summary = "";
  let firstTs = "";
  let lastTs = "";
  let messageCount = 0;
  let toolUseCount = 0;

  rows.forEach((row) => {
    const ts = getRowTimestamp(row);
    if (ts && (!firstTs || getSortableTimestamp(ts) < getSortableTimestamp(firstTs))) firstTs = ts;
    if (ts && (!lastTs || getSortableTimestamp(ts) > getSortableTimestamp(lastTs))) lastTs = ts;

    if (row.type === "session_meta" && row.payload) {
      if (row.payload.id) sessionId = String(row.payload.id);
      if (!cwdRaw && row.payload.cwd) cwdRaw = String(row.payload.cwd);
      if (!firstTs && row.payload.timestamp) firstTs = String(row.payload.timestamp);
      return;
    }

    if (row.type === "turn_context" && row.payload) {
      if (!cwdRaw && row.payload.cwd) cwdRaw = String(row.payload.cwd);
      if (!model && row.payload.model) model = String(row.payload.model);
      return;
    }

    if (row.type !== "response_item" || !row.payload) return;
    if (TOOL_USE_TYPES.has(row.payload.type)) {
      toolUseCount += 1;
      return;
    }
    if (row.payload.type !== "message") return;
    if (row.payload.role !== "user" && row.payload.role !== "assistant") return;

    const text = extractContentText(row.payload.content);
    if (!text) return;
    messageCount += 1;
    if (!summary && row.payload.role === "user") {
      summary = extractSessionTitle(text, 160);
    }
  });

  const normalizedProject = normalizeProjectPath(cwdRaw, options.projectPathMode || "realpath");

  return {
    sessionId,
    sessionRef: fileRecord.sessionRef,
    filePath: fileRecord.absolutePath,
    rootDir: fileRecord.rootDir,
    area: fileRecord.area,
    archived: fileRecord.area === "archived_sessions",
    projectId: normalizedProject.projectId,
    projectLabel: normalizedProject.projectId === "unknown"
      ? "unknown"
      : (normalizedProject.cwdResolved || normalizedProject.cwdRaw),
    projectShortLabel: toProjectShortLabel(normalizedProject.projectId),
    cwdRaw: normalizedProject.cwdRaw,
    cwdResolved: normalizedProject.cwdResolved,
    model,
    firstTs,
    lastTs,
    summary: summary || "(no user prompt found)",
    messageCount,
    toolUseCount,
    hasToolUse: toolUseCount > 0,
    mtimeMs: fileRecord.mtimeMs,
    size: fileRecord.size
  };
}

function getMetaCacheKey(baseDirs, options = {}) {
  return `${(baseDirs || []).map((item) => path.resolve(item)).join("|")}::${options.includeArchived !== false ? "1" : "0"}::${options.projectPathMode || "realpath"}`;
}

function listSessionMetas(baseDirs, options = {}) {
  const files = scanRollouts(baseDirs, options);
  const cacheKey = getMetaCacheKey(baseDirs, options);
  const signature = buildScanSignature(files);
  const now = Date.now();
  const cached = META_CACHE.get(cacheKey);
  if (cached && cached.signature === signature && cached.expiresAt > now) {
    return cached.value;
  }

  const value = sortByRecentSession(files.map((file) => extractSessionMeta(file, options)));
  META_CACHE.set(cacheKey, {
    signature,
    expiresAt: now + META_CACHE_TTL_MS,
    value
  });
  return value;
}

function normalizeToolInput(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.arguments === "string") return payload.arguments;
  if (payload.arguments != null) return JSON.stringify(payload.arguments, null, 2);
  if (typeof payload.input === "string") return payload.input;
  if (payload.input != null) return JSON.stringify(payload.input, null, 2);
  if (payload.action) return JSON.stringify(payload.action, null, 2);
  if (payload.command) return String(payload.command);
  return "";
}

function normalizeToolName(payload) {
  if (!payload || typeof payload !== "object") return "tool";
  if (payload.name) return String(payload.name);
  if (payload.type === "web_search_call") return "web_search";
  if (payload.action && payload.action.type) return `web_${payload.action.type}`;
  if (payload.command) return "local_shell";
  return payload.type || "tool";
}

function normalizeToolUseEntry(payload, timestamp, index) {
  return {
    id: `entry-${index}`,
    type: "tool_use",
    filterGroup: "tool",
    ts: timestamp,
    name: normalizeToolName(payload),
    input: normalizeToolInput(payload),
    callId: payload.call_id || "",
    status: payload.status || "",
    text: truncateText(`${normalizeToolName(payload)} ${normalizeToolInput(payload)}`, 200)
  };
}

function normalizeToolResultEntry(payload, relatedTool, timestamp, index) {
  const output = payload.output == null ? "" : String(payload.output);
  const toolName = relatedTool ? relatedTool.name : "tool";
  return {
    id: `entry-${index}`,
    type: "tool_result",
    filterGroup: "tool",
    ts: timestamp,
    name: toolName,
    callId: payload.call_id || "",
    output,
    text: truncateText(`${toolName} ${output}`, 220)
  };
}

function normalizeTokenCount(info) {
  const usage = (info && (info.last_token_usage || info.total_token_usage)) || {};
  const total = usage.total_tokens != null
    ? usage.total_tokens
    : (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0) + Number(usage.reasoning_output_tokens || 0));
  return {
    input: Number(usage.input_tokens || 0),
    cachedInput: Number(usage.cached_input_tokens || 0),
    output: Number(usage.output_tokens || 0),
    reasoning: Number(usage.reasoning_output_tokens || 0),
    total: Number(total || 0)
  };
}

function makeProgressText(eventType, payload) {
  if (eventType === "task_started") return "Turn started";
  if (eventType === "task_complete") return "Turn completed";
  if (eventType === "turn_aborted") return payload && payload.reason ? `Turn aborted: ${payload.reason}` : "Turn aborted";
  if (eventType === "context_compacted") return "Context compacted";
  if (eventType === "item_completed") return "Item completed";
  if (eventType === "web_search_end") {
    return `Web search finished: ${truncateText((payload && (payload.query || ((payload.action || {}).query))) || "", 120)}`;
  }
  if (eventType === "mcp_tool_call_end") {
    const invocation = (payload && payload.invocation) || {};
    const duration = payload && payload.duration
      ? `${Number(payload.duration.secs || 0) + Number(payload.duration.nanos || 0) / 1e9}s`
      : "";
    return `MCP tool finished: ${invocation.server || "mcp"}.${invocation.tool || "tool"}${duration ? ` (${duration})` : ""}`;
  }
  if (eventType === "patch_apply_end") {
    return payload && payload.success === false
      ? "Patch apply failed"
      : "Patch applied";
  }
  return eventType;
}

function makeProgressDetails(eventType, payload) {
  if (!payload || typeof payload !== "object") return "";
  if (eventType === "patch_apply_end") {
    return truncateText(payload.stdout || payload.stderr || "", 240);
  }
  if (eventType === "web_search_end") {
    const queries = (payload.action && payload.action.queries) || [];
    if (queries.length) return truncateText(queries.join("\n"), 240);
  }
  if (eventType === "mcp_tool_call_end") {
    const invocation = payload.invocation || {};
    return truncateText(JSON.stringify(invocation, null, 2), 240);
  }
  return "";
}

function shouldUseAgentReasoning(rows, index) {
  for (let cursor = index + 1; cursor < rows.length && cursor <= index + 3; cursor += 1) {
    const nextRow = rows[cursor];
    if (!nextRow || typeof nextRow !== "object") continue;
    if (nextRow.type === "response_item" && nextRow.payload && nextRow.payload.type === "reasoning") {
      return !extractReasoningSummary(nextRow.payload.summary);
    }
    if (nextRow.type === "response_item") return true;
  }
  return true;
}

function getParseCache(key) {
  if (!PARSE_CACHE.has(key)) return null;
  const value = PARSE_CACHE.get(key);
  PARSE_CACHE.delete(key);
  PARSE_CACHE.set(key, value);
  return value;
}

function setParseCache(key, value) {
  if (PARSE_CACHE.has(key)) PARSE_CACHE.delete(key);
  PARSE_CACHE.set(key, value);
  while (PARSE_CACHE.size > PARSE_CACHE_LIMIT) {
    const firstKey = PARSE_CACHE.keys().next().value;
    PARSE_CACHE.delete(firstKey);
  }
}

function parseRollout(fileRecord, options = {}) {
  const cacheKey = `${fileRecord.rootDir}::${fileRecord.sessionRef}::${fileRecord.mtimeMs}`;
  const cached = getParseCache(cacheKey);
  if (cached) return cached;

  const rows = readJsonl(fileRecord.absolutePath, true);
  const meta = extractSessionMeta(fileRecord, options);
  const entries = [];
  const toolUsesByCallId = new Map();
  let lastAssistantEntry = null;

  rows.forEach((row, rowIndex) => {
    const timestamp = getRowTimestamp(row);
    const entryIndex = entries.length;

    if (row.type === "broken") {
      entries.push({
        id: `entry-${entryIndex}`,
        type: "system",
        filterGroup: "system",
        ts: timestamp,
        text: `Unreadable JSONL line ${row.payload.lineNumber || ""}`.trim(),
        details: row.payload.line || ""
      });
      return;
    }

    if (row.type === "response_item" && row.payload) {
      const payload = row.payload;

      if (payload.type === "message") {
        if (payload.role !== "user" && payload.role !== "assistant") return;
        const text = extractContentText(payload.content);
        if (!text) return;
        const entry = {
          id: `entry-${entryIndex}`,
          type: payload.role,
          filterGroup: payload.role,
          role: payload.role,
          ts: timestamp,
          text
        };
        entries.push(entry);
        if (payload.role === "assistant") lastAssistantEntry = entry;
        return;
      }

      if (payload.type === "reasoning") {
        const summary = extractReasoningSummary(payload.summary);
        if (!summary) return;
        entries.push({
          id: `entry-${entryIndex}`,
          type: "thinking",
          filterGroup: "thinking",
          ts: timestamp,
          text: summary
        });
        return;
      }

      if (TOOL_USE_TYPES.has(payload.type)) {
        const entry = normalizeToolUseEntry(payload, timestamp, entryIndex);
        entries.push(entry);
        if (entry.callId) toolUsesByCallId.set(entry.callId, entry);
        return;
      }

      if (TOOL_RESULT_TYPES.has(payload.type)) {
        const entry = normalizeToolResultEntry(payload, toolUsesByCallId.get(payload.call_id || ""), timestamp, entryIndex);
        entries.push(entry);
      }

      return;
    }

    if (row.type === "event_msg" && row.payload) {
      const payload = row.payload;
      if (payload.type === "token_count") {
        if (lastAssistantEntry) {
          lastAssistantEntry.tokenCount = normalizeTokenCount(payload.info || {});
        }
        return;
      }

      if (payload.type === "user_message" || payload.type === "agent_message") return;

      if (payload.type === "agent_reasoning") {
        if (!shouldUseAgentReasoning(rows, rowIndex)) return;
        const text = String(payload.text || "").trim();
        if (!text) return;
        entries.push({
          id: `entry-${entryIndex}`,
          type: "thinking",
          filterGroup: "thinking",
          ts: timestamp,
          text
        });
        return;
      }

      if (PROGRESS_EVENT_TYPES.has(payload.type)) {
        entries.push({
          id: `entry-${entryIndex}`,
          type: payload.type === "task_started" ? "system" : "progress",
          filterGroup: "system",
          ts: timestamp,
          text: makeProgressText(payload.type, payload),
          details: makeProgressDetails(payload.type, payload)
        });
      }
      return;
    }

    if (row.type === "compacted") {
      entries.push({
        id: `entry-${entryIndex}`,
        type: "compact",
        filterGroup: "system",
        ts: timestamp,
        text: "Conversation compacted"
      });
    }
  });

  const parsed = {
    ...meta,
    entries
  };

  setParseCache(cacheKey, parsed);
  return parsed;
}

function buildSearchText(entry) {
  if (!entry) return "";
  return [
    entry.type,
    entry.role,
    entry.name,
    entry.text,
    entry.input,
    entry.output,
    entry.details
  ]
    .filter(Boolean)
    .join("\n");
}

function makeSnippet(text, query, limit = 180) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const normalizedSource = source.toLowerCase();
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return truncateText(source, limit);

  const index = normalizedSource.indexOf(normalizedQuery);
  if (index < 0) return truncateText(source, limit);

  const start = Math.max(0, index - 50);
  const end = Math.min(source.length, index + normalizedQuery.length + 90);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

function matchesQuery(text, query) {
  const normalizedText = String(text || "").toLowerCase();
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return false;
  return normalizedText.includes(normalizedQuery);
}

function isSafeSessionRef(sessionRef) {
  const normalized = toPosixPath(String(sessionRef || "").trim());
  if (!normalized) return false;
  if (normalized.startsWith("/") || normalized.includes("../")) return false;
  return normalized.startsWith("sessions/") || normalized.startsWith("archived_sessions/");
}

function createCodexRolloutStore(options = {}) {
  const baseDirs = (options.baseDirs || []).map((item) => path.resolve(item));
  const includeArchived = options.includeArchived !== false;
  const projectPathMode = options.projectPathMode || "realpath";

  function listFiles() {
    return scanRollouts(baseDirs, { includeArchived });
  }

  function listMetas() {
    return listSessionMetas(baseDirs, { includeArchived, projectPathMode });
  }

  function getSessionMeta(sessionRef) {
    return listMetas().find((item) => item.sessionRef === sessionRef) || null;
  }

  function getFileRecord(sessionRef) {
    return listFiles().find((item) => item.sessionRef === sessionRef) || null;
  }

  return {
    baseDirs,
    includeArchived,
    projectPathMode,
    listRollouts: listFiles,
    listSessionMetas: listMetas,
    listProjects() {
      const grouped = new Map();
      listMetas().forEach((meta) => {
        const key = meta.projectId;
        const existing = grouped.get(key);
        if (!existing) {
          grouped.set(key, {
            projectId: key,
            projectLabel: key === "unknown" ? "unknown" : toDisplayPath(meta),
            projectShortLabel: toProjectShortLabel(key),
            sessionCount: 1,
            latestTs: meta.lastTs || meta.firstTs,
            latestSessionRef: meta.sessionRef,
            latestSummary: meta.summary
          });
          return;
        }
        existing.sessionCount += 1;
        const existingMs = getSortableTimestamp(existing.latestTs) || 0;
        const metaMs = getSessionRecencyMs(meta);
        if (metaMs >= existingMs) {
          existing.latestTs = meta.lastTs || meta.firstTs;
          existing.latestSessionRef = meta.sessionRef;
          existing.latestSummary = meta.summary;
          if (key !== "unknown") existing.projectLabel = toDisplayPath(meta);
        }
      });

      return Array.from(grouped.values()).sort((left, right) => {
        const diff = getSortableTimestamp(right.latestTs) - getSortableTimestamp(left.latestTs);
        if (diff !== 0) return diff;
        return String(left.projectId).localeCompare(String(right.projectId));
      });
    },
    listSessions(projectId, limit) {
      let sessions = listMetas();
      if (projectId) sessions = sessions.filter((item) => item.projectId === projectId);
      if (Number.isFinite(limit) && limit > 0) {
        sessions = sessions.slice(0, limit);
      }
      return sessions;
    },
    getSessionMeta,
    getSession(sessionRef) {
      const fileRecord = getFileRecord(sessionRef);
      if (!fileRecord) return null;
      return parseRollout(fileRecord, { projectPathMode });
    },
    search(query, projectId, limit = 20) {
      const normalizedQuery = String(query || "").trim().toLowerCase();
      if (!normalizedQuery) return [];

      const results = [];
      const sessions = this.listSessions(projectId);
      sessions.some((meta) => {
        const metaHaystack = [
          meta.summary,
          meta.projectLabel,
          meta.projectId,
          meta.sessionRef
        ].join("\n");

        let snippet = "";
        let matchType = "session";
        if (matchesQuery(metaHaystack, normalizedQuery)) {
          snippet = makeSnippet(metaHaystack, normalizedQuery);
        } else {
          const session = this.getSession(meta.sessionRef);
          if (!session) return false;
          const hit = session.entries.find((entry) => matchesQuery(buildSearchText(entry), normalizedQuery));
          if (!hit) return false;
          snippet = makeSnippet(buildSearchText(hit), normalizedQuery);
          matchType = hit.type;
        }

        results.push({
          sessionRef: meta.sessionRef,
          projectId: meta.projectId,
          projectLabel: meta.projectLabel,
          projectShortLabel: meta.projectShortLabel,
          summary: meta.summary,
          snippet,
          matchType,
          lastTs: meta.lastTs || meta.firstTs,
          model: meta.model
        });

        return results.length >= limit;
      });

      return results;
    },
    deleteSession(sessionRef) {
      const normalized = toPosixPath(String(sessionRef || "").trim());
      if (!isSafeSessionRef(normalized)) {
        return { ok: false, error: "invalid sessionRef" };
      }

      const fileRecord = getFileRecord(normalized);
      const meta = getSessionMeta(normalized);
      if (!fileRecord) {
        return { ok: false, error: "session not found" };
      }

      const fullPath = path.resolve(fileRecord.absolutePath);
      const sessionsRoot = path.resolve(fileRecord.rootDir, "sessions");
      const archivedRoot = path.resolve(fileRecord.rootDir, "archived_sessions");
      const insideSessions = fullPath.startsWith(`${sessionsRoot}${path.sep}`) || fullPath === sessionsRoot;
      const insideArchived = fullPath.startsWith(`${archivedRoot}${path.sep}`) || fullPath === archivedRoot;
      if (!insideSessions && !insideArchived) {
        return { ok: false, error: "delete target outside allowed directories" };
      }

      fs.unlinkSync(fullPath);
      clearCodexCaches();

      const remaining = this.listSessions(meta ? meta.projectId : "");
      return {
        ok: true,
        deleted: normalized,
        nextSessionRef: remaining.length ? remaining[0].sessionRef : "",
        projectId: meta ? meta.projectId : ""
      };
    },
    getDoctorInfo() {
      const files = listFiles();
      const projects = this.listProjects();
      const sessions = this.listSessions();
      const rootDir = baseDirs[0] || "";
      const archivedDir = rootDir ? path.join(rootDir, "archived_sessions") : "";
      return {
        rootDir,
        includeArchived,
        archivedExists: archivedDir ? fs.existsSync(archivedDir) : false,
        rolloutCount: files.length,
        projectCount: projects.length,
        recentSession: sessions[0] || null
      };
    }
  };
}

module.exports = {
  buildSearchText,
  clearCodexCaches,
  createCodexRolloutStore,
  extractContentText,
  extractReasoningSummary,
  extractSessionMeta,
  isSafeSessionRef,
  makeSnippet,
  normalizeProjectPath,
  parseRollout,
  scanRollouts,
  sortByRecentSession,
  toDisplayPath,
  truncateText
};
