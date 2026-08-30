import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(PROJECT_ROOT, "bin", "hub-mcp.mjs");

/**
 * 送出一組 JSON-RPC 訊息，收集伺服器的回應。
 *
 * 這裡刻意只用不會碰到資料庫的請求，測試才不必啟動 Wrangler——
 * 需要真實資料的驗證屬於手動驗收，不放進單元測試。
 *
 * @param {any[]} messages
 * @returns {Promise<{ responses: any[], stderr: string, code: number }>}
 */
function runSession(messages) {
  return runSessionRaw(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
}

/**
 * 直接送出原始文字，用來測試格式錯誤的輸入。
 *
 * @param {string} input
 * @returns {Promise<{ responses: any[], stdout: string, stderr: string, code: number }>}
 */
function runSessionRaw(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { cwd: PROJECT_ROOT });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const responses = stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));

      resolve({ responses, stdout, stderr, code: code ?? 0 });
    });

    child.stdin.end(input);
  });
}

test("initialize echoes a supported protocol version and advertises tools", async () => {
  const { responses } = await runSession([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    },
  ]);

  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.protocolVersion, "2025-03-26");
  assert.ok(responses[0].result.capabilities.tools);
  assert.equal(responses[0].result.serverInfo.name, "ai-project-hub");
});

test("an unknown protocol version falls back to a version the server supports", async () => {
  const { responses } = await runSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
  ]);

  assert.notEqual(responses[0].result.protocolVersion, "1999-01-01");
});

test("only read-only tools are exposed in this stage", async () => {
  const { responses } = await runSession([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  const names = responses[0].result.tools.map((tool) => tool.name);

  // get_deployment_pitfalls 於 2026-08-17 加入：它回傳靜態的踩坑知識，
  // 不碰資料庫、不改任何狀態，因此仍在「唯讀」範圍內。
  assert.deepEqual(names.sort(), [
    "get_deployment_pitfalls",
    "get_deployment_status",
    "get_project",
    "list_projects",
  ]);

  // 會改變狀態的工具屬於階段 G，現在出現就是提早暴露了未完成的能力。
  //
  // 這份清單是本測試真正的守門功能：上面的 deepEqual 會在新增任何工具時失敗，
  // 迫使人回來確認新工具是否真的唯讀；下面的迴圈則擋住已知的寫入型工具名稱。
  for (const forbidden of ["deploy_project", "delete_project", "set_visibility", "rollback_project"]) {
    assert.ok(!names.includes(forbidden), `階段 A 不應提供 ${forbidden}`);
  }
});

test("every tool declares a schema that rejects unexpected properties", async () => {
  const { responses } = await runSession([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);

  for (const tool of responses[0].result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} 應拒絕未知參數`);
  }
});

test("notifications receive no response", async () => {
  const { responses } = await runSession([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "ping" },
  ]);

  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 1);
});

test("an unknown method is a protocol error, an unknown tool is a tool error", async () => {
  const { responses } = await runSession([
    { jsonrpc: "2.0", id: 1, method: "resources/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rm_rf", arguments: {} } },
  ]);

  const byId = new Map(responses.map((item) => [item.id, item]));

  assert.equal(byId.get(1).error.code, -32601);
  assert.equal(byId.get(2).result.isError, true);
  assert.match(byId.get(2).result.content[0].text, /不認得的工具/);
});

test("stdout carries JSON-RPC only, so a stray log cannot break the host", async () => {
  const { stdout } = await runSession([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);

  const lines = stdout.split("\n").filter((line) => line.trim() !== "");

  assert.ok(lines.length > 0);

  for (const line of lines) {
    const message = JSON.parse(line);

    assert.equal(message.jsonrpc, "2.0", `不是 JSON-RPC 訊息：${line.slice(0, 80)}`);
  }
});

test("malformed input is reported without taking the server down", async () => {
  const { responses, code } = await runSessionRaw(
    'this is not json\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n',
  );

  const byId = new Map(responses.map((item) => [item.id, item]));

  assert.equal(byId.get(0).error.code, -32700);
  assert.deepEqual(byId.get(9).result, {});
  assert.equal(code, 0);
});
