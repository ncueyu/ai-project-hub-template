#!/usr/bin/env node

/**
 * hub MCP server —— 階段 A 骨架（唯讀）。
 *
 * 這是一支跑在本機的程式，透過標準輸入輸出與 AI 工具溝通（stdio transport）。
 * **不是網路伺服器**：沒有對外開埠，沒有任何人能從網路連進來。
 *
 * 三個規則貫穿本檔：
 *   1. **標準輸出只能有 JSON-RPC 訊息。** 任何說明文字、警告、除錯訊息一律
 *      走 stderr——混進 stdout 會讓宿主的解析直接失敗，而且錯誤訊息通常
 *      只會顯示「無法連線」，很難查。
 *   2. **只提供唯讀工具。** 會改變狀態的工具屬於階段 G，且必須先有階段 G
 *      的安全規則（驗證輸入、不接受任意 shell 指令）才能加入。
 *   3. **不回傳任何秘密。** 查詢層完全不碰 `project_policies`（密碼雜湊所在）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PROJECT_ROOT } from "../tools/config.mjs";
import { listPitfalls, SCOPES } from "../tools/pitfalls.mjs";
import { getDeploymentStatus, listProjects } from "../tools/queries.mjs";

const SERVER_NAME = "ai-project-hub";

/** 已知的協定版本，新到舊。宿主要求的版本若在清單內就照它回覆。 */
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

/**
 * @returns {string}
 */
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));

    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VISIBILITY_DESCRIPTION = "可見性：public（公開）／unlisted（不列出）／"
  + "password（需要密碼）／private（私人）／disabled（停用）";

const TOOLS = Object.freeze([
  {
    name: "list_projects",
    title: "列出專案",
    description: "列出 Hub 中的專案。可依可見性篩選。不會回傳任何密碼或金鑰。",
    inputSchema: {
      type: "object",
      properties: {
        visibility: { type: "string", description: VISIBILITY_DESCRIPTION },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "最多回傳幾筆，預設 50" },
        remote: { type: "boolean", description: "true 讀遠端 D1，預設 false 讀本機模擬資料庫" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_project",
    title: "取得單一專案",
    description: "以代稱（例如 my-project）或編號取得單一專案的完整資料。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案代稱或編號" },
        remote: { type: "boolean", description: "true 讀遠端 D1，預設 false" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_deployment_status",
    title: "取得部署狀態",
    description: "取得專案目前的線上網址與最近幾筆部署紀錄。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案代稱或編號" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "最多回傳幾筆紀錄，預設 10" },
        remote: { type: "boolean", description: "true 讀遠端 D1，預設 false" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_deployment_pitfalls",
    title: "查詢部署踩坑清單",
    // description 刻意寫得像使用指示而不只是功能說明：
    // MCP 的工具描述是 AI 唯一會讀到的提示，要在這裡就講清楚「什麼時候該呼叫」。
    description: "列出已知的部署踩坑，每一項含症狀、原因、修法，以及最重要的「怎麼確認自己踩到了」。"
      + "**執行任何部署相關操作之前應先查詢對應情境。**"
      + "這些坑的共同特徵是不會有錯誤訊息——部署會顯示成功、掃描會回報乾淨、程式會跑完，"
      + "但結果是錯的。可用情境：tooling（指令與環境）、config（設定檔）、deploy（部署）、"
      + "database（資料庫）、verify（驗證方式）、content（教材與圖片）。不填則回傳全部。",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "情境代碼，例如 deploy。不填回傳全部",
        },
      },
      additionalProperties: false,
    },
  },
]);

/**
 * 執行一個工具。
 *
 * 參數由 AI 產生，一律視為不可信輸入——實際的形狀檢查在 `queries.mjs`
 * 的 assert 系列，這裡只負責把錯誤轉成宿主看得懂的回應。
 *
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {Promise<any>}
 */
export async function callTool(name, args = {}) {
  const remote = args.remote === true;

  if (name === "list_projects") {
    const options = { remote };

    if (args.visibility !== undefined) {
      Object.assign(options, { visibility: args.visibility });
    }

    if (args.limit !== undefined) {
      Object.assign(options, { limit: args.limit });
    }

    return { projects: await listProjects(options) };
  }

  if (name === "get_project") {
    const status = await getDeploymentStatus(args.project, { remote, limit: 1 });

    if (!status) {
      throw new Error(`找不到專案：${String(args.project)}`);
    }

    return status.project;
  }

  if (name === "get_deployment_status") {
    const options = { remote };

    if (args.limit !== undefined) {
      Object.assign(options, { limit: args.limit });
    }

    const status = await getDeploymentStatus(args.project, options);

    if (!status) {
      throw new Error(`找不到專案：${String(args.project)}`);
    }

    return status;
  }

  if (name === "get_deployment_pitfalls") {
    // 這一支不碰資料庫、不需要 remote 參數——它回傳的是靜態知識。
    const scope = typeof args.scope === "string" ? args.scope : "";
    const pitfalls = listPitfalls({ scope });

    if (pitfalls.length === 0) {
      throw new Error(`不認得的情境：${scope}。可用情境：${Object.keys(SCOPES).join("、")}`);
    }

    return { scopes: SCOPES, count: pitfalls.length, pitfalls };
  }

  throw new Error(`不認得的工具：${name}`);
}

/**
 * @param {any} message
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * @param {string | number} id
 * @param {any} result
 */
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

/**
 * @param {string | number} id
 * @param {number} code
 * @param {string} message
 */
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * @param {any} request
 */
async function handleRequest(request) {
  const { id, method, params } = request;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSIONS[0];

    sendResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: readVersion() },
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;

    try {
      const data = await callTool(name, params?.arguments ?? {});

      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      });
    } catch (error) {
      // 工具層的失敗回成 isError 而不是 JSON-RPC error：讓 AI 讀得到原因並
      // 自行修正參數，而不是只看到一句「呼叫失敗」。
      sendResult(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }

    return;
  }

  sendError(id, -32601, `不支援的方法：${method}`);
}

/**
 * @param {string} line
 */
async function handleLine(line) {
  const trimmed = line.trim();

  if (trimmed === "") {
    return;
  }

  let message;

  try {
    message = JSON.parse(trimmed);
  } catch {
    sendError(0, -32700, "無法解析的 JSON。");
    return;
  }

  // 通知（沒有 id）不需要回應，例如 notifications/initialized。
  if (message.id === undefined || message.id === null) {
    return;
  }

  try {
    await handleRequest(message);
  } catch (error) {
    sendError(message.id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function start() {
  let buffer = "";

  // 處理中的請求數。stdin 關閉時不能立刻結束行程——查詢 D1 是非同步的，
  // 直接 exit 會把還在途中的回應丟掉，而宿主只會看到「沒有回應」。
  let pending = 0;
  let inputEnded = false;

  function exitWhenIdle() {
    if (inputEnded && pending === 0) {
      process.exit(0);
    }
  }

  /**
   * @param {string} line
   */
  function track(line) {
    pending += 1;

    handleLine(line).finally(() => {
      pending -= 1;
      exitWhenIdle();
    });
  }

  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    let index = buffer.indexOf("\n");

    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      track(line);
      index = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    // 最後一行可能沒有換行結尾。
    if (buffer.trim() !== "") {
      track(buffer);
      buffer = "";
    }

    inputEnded = true;
    exitWhenIdle();
  });
}

// 被直接執行時才接管 stdin；被 import 時（測試）不啟動，否則測試會掛住。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
