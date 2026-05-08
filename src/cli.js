import { startServer } from "./server.js";
import { getStats, listSessions } from "./lib/session-store.js";

function printDesign() {
  console.log("AI Session Manager");
  console.log("");
  console.log("形态: CLI + 本地网页界面");
  console.log("MVP: 列表、筛选、统计、详情、归档/异常识别");
  console.log("当前: 聚合 Codex / Claude Code / Gemini CLI，会话管理动作按 provider 能力开放");
}

function printScanSummary() {
  const stats = getStats();
  const sessions = listSessions();

  console.log("Session summary");
  console.log(`- total: ${stats.total}`);
  console.log(`- active: ${stats.active}`);
  console.log(`- archived: ${stats.archived}`);
  console.log(`- problematic links: ${stats.brokenLinks}`);
  console.log(`- total tokens: ${stats.totalTokens}`);
  console.log("");

  sessions.forEach((session) => {
    console.log(`[${session.provider}/${session.status}/${session.linkStatus}] ${session.title}`);
  });
}

async function run() {
  const command = process.argv[2] || "serve";

  if (command === "design") {
    printDesign();
    return;
  }

  if (command === "scan") {
    printScanSummary();
    return;
  }

  if (command === "fixture") {
    console.log("Run: npm run fixture");
    return;
  }

  if (command === "serve") {
    const port = Number(process.env.PORT || 4123);
    await startServer({ port });
    console.log(`AI Session Manager is running at http://127.0.0.1:${port}`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

run();
