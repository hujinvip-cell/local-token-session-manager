import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveSession,
  deleteSession,
  getSessionById,
  getStats,
  getProviders,
  getUsageStats,
  getWorkspaces,
  getWorkspaceGroups,
  listSessions,
  refreshSessions,
  unarchiveSession
} from "./lib/session-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const webRoot = join(__dirname, "..", "web");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data, null, 2));
}

function parseFilters(requestUrl) {
  const params = requestUrl.searchParams;
  return {
    keyword: params.get("keyword") || "",
    status: params.get("status") || "all",
    linkStatus: params.get("linkStatus") || "all",
    provider: params.get("provider") || "all",
    workspace: params.get("workspace") || "all",
    startDate: params.get("startDate") || "",
    endDate: params.get("endDate") || "",
    onlyIssues: params.get("onlyIssues") || "false"
  };
}

async function serveStatic(pathname, response) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(webRoot, normalizedPath);
  const extension = extname(filePath);
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream"
  });
  response.end(body);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

export function startServer({ port = 4123 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host}`);

      if (requestUrl.pathname === "/api/sessions") {
        const sessions = listSessions(parseFilters(requestUrl));
        sendJson(response, 200, sessions);
        return;
      }

      if (requestUrl.pathname.startsWith("/api/sessions/")) {
        const remainder = requestUrl.pathname.replace("/api/sessions/", "");
        const [id, action] = remainder.split("/");

        if (request.method === "POST" && action) {
          await readRequestBody(request);

          if (action === "archive") {
            sendJson(response, 200, archiveSession(id));
            return;
          }

          if (action === "unarchive") {
            sendJson(response, 200, unarchiveSession(id));
            return;
          }

          if (action === "delete") {
            sendJson(response, 200, deleteSession(id));
            return;
          }
        }

        const session = getSessionById(id);

        if (!session) {
          sendJson(response, 404, { message: "Session not found." });
          return;
        }

        sendJson(response, 200, session);
        return;
      }

      if (requestUrl.pathname === "/api/stats") {
        sendJson(response, 200, getStats());
        return;
      }

      if (requestUrl.pathname === "/api/usage") {
        sendJson(response, 200, getUsageStats({ range: requestUrl.searchParams.get("range") || "30d" }));
        return;
      }

      if (requestUrl.pathname === "/api/refresh") {
        sendJson(response, 200, refreshSessions());
        return;
      }

      if (requestUrl.pathname === "/api/meta") {
        sendJson(response, 200, {
          workspaces: getWorkspaces(),
          workspaceGroups: getWorkspaceGroups(),
          providers: getProviders(),
          roadmap: [
            "补充 provider 级统计面板",
            "增加 token 配额和刷新时间面板",
            "支持批量管理和异常修复"
          ]
        });
        return;
      }

      await serveStatic(requestUrl.pathname, response);
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : 500;
      sendJson(response, statusCode, {
        message: statusCode === 404 ? "Not found." : "Unexpected server error.",
        detail: error.message
      });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}
