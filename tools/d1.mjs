/**
 * 透過 Wrangler 讀寫 D1。
 *
 * 為什麼不打 Hub 的 HTTP API：
 *   1. 管理 API 受 `ADMIN_ENABLED` 管轄，部署出去的版本一律回 404
 *      （2026-08-14 工作計畫 C1）。
 *   2. 走 Wrangler 就不必為了讓 CLI 能用而在公開網址上開一個可寫入的入口。
 * 這是 D1 裁定的方案 1。
 *
 * 只在本機執行，不會被 Worker 打包。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PROJECT_ROOT, getDatabaseName, hasRemoteDatabase } from "./config.mjs";

/**
 * 找出 Wrangler 的進入點。
 *
 * 不使用 `npx wrangler` 或 `pnpm exec wrangler`：本機的 pnpm 不在 PATH 上
 * （已知環境事實），而 `npx` 在離線時可能嘗試下載。直接用 Node 執行
 * node_modules 內的檔案，路徑由專案根目錄推得，沒有任何寫死的絕對路徑。
 *
 * @returns {string}
 */
export function resolveWranglerEntry() {
  const entry = join(PROJECT_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

  if (!existsSync(entry)) {
    throw new Error(
      "找不到 Wrangler。請先在專案根目錄安裝相依套件（corepack pnpm install）。",
    );
  }

  return entry;
}

/**
 * 建立 Wrangler 需要的環境變數。
 *
 * `XDG_CONFIG_HOME` 未設定時，Wrangler 在本機曾出現 EPERM（已知環境事實，
 * 見 `0813-工作紀錄.md`）。因此預設把它指向暫存目錄，避開全域設定的寫入權限問題。
 *
 * **但遠端操作不能這樣做**（2026-08-16 修正）：`wrangler login` 產生的 OAuth 憑證
 * 存放在 Wrangler 的預設設定目錄（Windows 上是 `%APPDATA%\xdg.config\.wrangler\`），
 * 一旦把 `XDG_CONFIG_HOME` 改指到暫存目錄，Wrangler 就找不到登入狀態，會回報
 * 「In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN」。
 * 這使得 `hub` 的所有 `--remote` 功能全部失效，連帶擋住部署紀錄回寫。
 *
 * 因此規則是：
 *   1. 使用者已自行設定 → 一律尊重，不覆蓋。
 *   2. 遠端操作且靠 OAuth 認證（沒有 `CLOUDFLARE_API_TOKEN`）→ 不覆蓋，
 *      讓 Wrangler 讀得到登入憑證。EPERM 的風險換取可用的認證，兩者無法兼得。
 *   3. 其餘情況（本機操作，或已用 API Token 認證而不需要設定檔）→ 維持暫存目錄隔離。
 *
 * @param {{ remote?: boolean }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
function buildEnv(options = {}) {
  if (process.env.XDG_CONFIG_HOME) {
    return process.env;
  }

  if (options.remote === true && !process.env.CLOUDFLARE_API_TOKEN) {
    return process.env;
  }

  return { ...process.env, XDG_CONFIG_HOME: join(tmpdir(), "wrangler-config") };
}

/**
 * 把值轉成可以安插進 SQL 的字面值。
 *
 * `wrangler d1 execute` 只接受完整的 SQL 字串，**無法傳遞繫結參數**。
 * 因此所有進入 SQL 的值都必須先經過本函式，且呼叫端有義務先驗證型別
 * （見 `queries.mjs` 的 assert 系列）。兩道防線缺一不可：驗證負責擋掉
 * 不該出現的形狀，跳脫負責處理合法但含特殊字元的值。
 *
 * @param {string | number} value
 * @returns {string}
 */
export function sqlLiteral(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error("只接受整數。");
    }

    return String(value);
  }

  if (typeof value !== "string") {
    throw new Error("只接受字串或整數。");
  }

  if (value.includes("\u0000")) {
    throw new Error("字串不可包含 NUL 字元。");
  }

  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 從 Wrangler 的輸出中取出 JSON。
 *
 * 即使指定 `--json`，某些情況下仍可能夾帶警告文字。這裡從第一個 `[` 或
 * `{` 開始解析，而不是假設整段輸出都是 JSON。
 *
 * @param {string} stdout
 * @returns {any}
 */
export function extractJson(stdout) {
  const start = stdout.search(/[[{]/);

  if (start === -1) {
    throw new Error(`Wrangler 沒有回傳 JSON：${stdout.trim().slice(0, 300)}`);
  }

  return JSON.parse(stdout.slice(start));
}

/**
 * 查詢佇列。
 *
 * 每次查詢都會啟動一個獨立的 Wrangler 行程；兩個行程同時存取本機模擬的
 * D1 時，miniflare 會回報 internal error（2026-08-14 實測：MCP 同時處理
 * 兩個 tools/call 即重現）。錯誤訊息指向 miniflare 內部，完全看不出真正的
 * 原因是併發，因此在這裡就地擋住，不讓它有機會發生。
 *
 * 這也順帶避免了「一次開一堆 Wrangler」的資源浪費。
 *
 * @type {Promise<unknown>}
 */
let queue = Promise.resolve();

/**
 * 把工作排進佇列，確保同一時間只有一個 Wrangler 行程在跑。
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueue(task) {
  // catch 讓前一個工作的失敗不會卡住整條佇列。
  const result = queue.then(task, task);

  queue = result.catch(() => undefined);

  return result;
}

/**
 * 執行一段唯讀或寫入的 SQL。
 *
 * @param {string} sql
 * @param {{ remote?: boolean, databaseName?: string }} [options]
 * @returns {Promise<Record<string, any>[]>} 第一個敘述的 results
 */
export async function executeSql(sql, options = {}) {
  const remote = options.remote === true;

  if (remote && !hasRemoteDatabase()) {
    throw new Error(
      "遠端 D1 尚未建立（wrangler.jsonc 的 database_id 仍是佔位值）。"
        + "請先建立遠端資料庫並填入真實的 database_id，或改用本機模式。",
    );
  }

  const databaseName = options.databaseName ?? getDatabaseName();
  const args = [
    resolveWranglerEntry(),
    "d1",
    "execute",
    databaseName,
    remote ? "--remote" : "--local",
    "--command",
    sql,
    "--json",
  ];

  const { stdout, stderr, code } = await enqueue(() => runNode(args, { remote }));

  if (code !== 0) {
    throw new Error(`Wrangler 執行失敗（代碼 ${code}）：${(stderr || stdout).trim().slice(0, 500)}`);
  }

  const parsed = extractJson(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;

  if (!first || first.success === false) {
    throw new Error("D1 回報這次查詢未成功。");
  }

  return Array.isArray(first.results) ? first.results : [];
}

/**
 * 執行一個 .sql 檔案裡的所有敘述。
 *
 * 為什麼需要它而不是沿用 `executeSql()`：那個走 `--command`，把整段 SQL 當成
 * 一個命令列參數。縮圖分成 26 段之後，總長度是 MB 等級，遠超過作業系統對
 * 單一參數的長度限制——只有 `--file` 這條路走得通。
 *
 * 呼叫端負責建立與刪除那個檔案。這裡刻意不接受 SQL 字串再自己寫檔，
 * 因為暫存檔的生命週期（放哪裡、失敗時要不要留著給人看）是呼叫端的決定。
 *
 * @param {string} filePath 絕對路徑
 * @param {{ remote?: boolean, databaseName?: string }} [options]
 * @returns {Promise<void>}
 */
export async function executeSqlFile(filePath, options = {}) {
  const remote = options.remote === true;

  if (remote && !hasRemoteDatabase()) {
    throw new Error(
      "遠端 D1 尚未建立（wrangler.jsonc 的 database_id 仍是佔位值）。"
        + "請先建立遠端資料庫並填入真實的 database_id，或改用本機模式。",
    );
  }

  const databaseName = options.databaseName ?? getDatabaseName();
  const args = [
    resolveWranglerEntry(),
    "d1",
    "execute",
    databaseName,
    remote ? "--remote" : "--local",
    "--file",
    filePath,
  ];

  const { stdout, stderr, code } = await enqueue(() => runNode(args, { remote }));

  if (code !== 0) {
    throw new Error(`Wrangler 執行失敗（代碼 ${code}）：${(stderr || stdout).trim().slice(0, 500)}`);
  }
}

/**
 * @param {string[]} args
 * @param {{ remote?: boolean }} [options] 遠端操作需要保留 Wrangler 的登入憑證，見 buildEnv()
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function runNode(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: buildEnv(options),
      // Windows 下不使用 shell，避免路徑含空白或中文時被重新斷詞。
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, code: code ?? 0 });
    });
  });
}
