/**
 * 環境檢查（2026-08-14 工作計畫 TASK A-5）。
 *
 * 目的：讓「別人照著教材在自己的電腦上重建一套」這件事有一個可執行的
 * 檢查點，而不是等到某個指令失敗才發現少裝東西
 * （claude.md §1 環境重現性協議）。
 *
 * 用法：node scripts/check-environment.mjs
 *
 * 這支程式**只檢查、不修改**任何東西。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MIN_NODE_MAJOR, PROJECT_ROOT, getDatabaseName, hasRemoteDatabase, readWranglerConfig } from "../tools/config.mjs";

/** Node 的最低版本。低於此版本的內建測試執行器與 fetch 行為會有差異。 */

/** @type {{ level: "ok" | "warn" | "fail", title: string, detail: string }[]} */
const results = [];

/**
 * @param {"ok" | "warn" | "fail"} level
 * @param {string} title
 * @param {string} detail
 */
function record(level, title, detail) {
  results.push({ level, title, detail });
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);

  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) {
    record("ok", "Node.js", `${process.versions.node}`);
    return;
  }

  record(
    "fail",
    "Node.js",
    `目前是 ${process.versions.node}，需要 ${MIN_NODE_MAJOR} 以上。請到 nodejs.org 安裝新版。`,
  );
}

function checkDependencies() {
  const wrangler = join(PROJECT_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

  if (!existsSync(wrangler)) {
    record(
      "fail",
      "相依套件",
      "找不到 Wrangler。請在專案根目錄執行：corepack pnpm install",
    );
    return;
  }

  let version = "";

  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "node_modules", "wrangler", "package.json"), "utf8"));
    version = typeof pkg.version === "string" ? ` ${pkg.version}` : "";
  } catch {
    version = "";
  }

  record("ok", "相依套件", `Wrangler${version} 已安裝`);
}

function checkWranglerConfig() {
  try {
    const config = readWranglerConfig();
    const databaseName = getDatabaseName(config);

    record("ok", "wrangler.jsonc", `可讀取，D1 資料庫名稱：${databaseName}`);

    if (hasRemoteDatabase(config)) {
      record("ok", "遠端 D1", "database_id 已填入真實值");
    } else {
      record(
        "warn",
        "遠端 D1",
        "database_id 仍是佔位值。本機開發不受影響；要用 --remote 之前必須先建立遠端資料庫。",
      );
    }
  } catch (error) {
    record("fail", "wrangler.jsonc", error instanceof Error ? error.message : String(error));
  }
}

function checkDevVars() {
  const devVars = join(PROJECT_ROOT, ".dev.vars");

  if (existsSync(devVars)) {
    record("ok", ".dev.vars", "已存在（本機才有，不會被部署）");
    return;
  }

  record(
    "warn",
    ".dev.vars",
    "不存在。本機管理後台會是關閉狀態。需要時複製 .dev.vars.example 為 .dev.vars。",
  );
}

function checkLocalDatabase() {
  const stateDir = join(PROJECT_ROOT, ".wrangler", "state");

  if (existsSync(stateDir)) {
    record("ok", "本機模擬資料庫", "已初始化");
    return;
  }

  record(
    "warn",
    "本機模擬資料庫",
    "尚未初始化。第一次執行 wrangler dev 或 seed:local 時會自動建立。",
  );
}

function checkHubTools() {
  const missing = [
    "bin/hub.mjs",
    "bin/hub-mcp.mjs",
    "src/hub/manifest.js",
    "tools/config.mjs",
    "tools/d1.mjs",
    "tools/queries.mjs",
  ].filter((relative) => !existsSync(join(PROJECT_ROOT, relative)));

  if (missing.length === 0) {
    record("ok", "hub 工具", "檔案齊全");
    return;
  }

  record("fail", "hub 工具", `缺少檔案：${missing.join("、")}`);
}

checkNode();
checkDependencies();
checkWranglerConfig();
checkDevVars();
checkLocalDatabase();
checkHubTools();

const symbols = { ok: "[OK]  ", warn: "[注意]", fail: "[失敗]" };

process.stdout.write("環境檢查結果\n\n");

for (const item of results) {
  process.stdout.write(`${symbols[item.level]} ${item.title}：${item.detail}\n`);
}

const failed = results.filter((item) => item.level === "fail");
const warned = results.filter((item) => item.level === "warn");

process.stdout.write("\n");

if (failed.length > 0) {
  process.stdout.write(`有 ${failed.length} 項必須先處理，處理完再執行一次這支檢查。\n`);
  process.exitCode = 1;
} else if (warned.length > 0) {
  process.stdout.write(`可以開始使用。有 ${warned.length} 項提醒，不影響本機操作。\n`);
} else {
  process.stdout.write("全部通過。\n");
}
