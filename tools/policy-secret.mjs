/**
 * 讀取專案的密碼雜湊，**只給部署時注入 Secret 用**。
 *
 * ## 為什麼要另開一個模組，而不是加進 `tools/queries.mjs`
 *
 * `queries.mjs` 的檔頭寫著一條刻意的界線：「本檔**完全不查詢**
 * `project_policies`」，理由是**MCP 工具的輸出會直接進入 AI 的脈絡**。
 * 那條界線是對的，不該為了這個功能破壞它——一旦雜湊有機會出現在任何會被
 * 回傳或印出的結果裡，「密碼不經過 AI」這個保證就沒了。
 *
 * 所以這個模組刻意做成一條**單向的窄管道**：
 *
 *   - 只有一個函式，只回傳雜湊字串本身，沒有其他欄位。
 *   - 唯一的呼叫端是 `tools/ship.mjs`，而且它拿到之後直接交給
 *     `deployWithSecrets()` 寫進暫存檔（該檔用 try/finally 刪除）。
 *   - **【嚴禁】把回傳值放進任何步驟訊息、log、`--json` 輸出，或 MCP 工具**。
 *     `test/ship-password.test.mjs` 有一條測試就在盯這件事。
 *
 * ## 為什麼查得到才算數
 *
 * 權限設成「需要密碼」但實際上還沒設密碼，是一個真實會發生的狀態
 * （後台可以先改權限、之後才輸入密碼）。這種情況**必須停下**，不能當成
 * 「沒有密碼保護」照樣部署——那會產生一個宣稱受保護、實際上誰都能開的網站，
 * 而使用者以為它是鎖著的。所以這裡查不到就回 null，由呼叫端停止。
 */

import { executeSql } from "./d1.mjs";
import { assertProjectId } from "./queries.mjs";

/**
 * 組出讀取雜湊的 SQL。抽成純函式以便單獨測試，不必真的啟動 Wrangler
 * （與 `queries.mjs` 的 `build*` 同一種寫法）。
 *
 * 只選 `password_hash` 一個欄位：列名而不是 `SELECT *`，讓「哪些欄位會被讀出來」
 * 是一眼可查的事實。
 *
 * @param {number} projectId
 * @returns {string}
 */
export function buildPasswordHashSql(projectId) {
  // 用 projectId 而不是 slug：`ensureProjectRegistered()` 回傳的物件裡有
  // projectId 但**沒有 slug**（回傳型別是 { projectId, visibility, isNew }），
  // 而且直接用主鍵查也省掉一個 JOIN。
  const id = assertProjectId(projectId);

  return `SELECT password_hash FROM project_policies WHERE project_id = ${id};`;
}

/**
 * 讀出某個專案的密碼雜湊。
 *
 * @param {number} projectId
 * @param {{ remote?: boolean, executeSql?: typeof executeSql }} [options]
 * @returns {Promise<string | null>} 沒設定密碼時回 null
 */
export async function readPasswordHash(projectId, options = {}) {
  const run = options.executeSql ?? executeSql;
  const rows = await run(buildPasswordHashSql(projectId), { remote: options.remote === true });

  const hash = rows[0]?.password_hash;

  // 空字串與 null 都當成「沒設定」——空字串當雜湊用會讓任何密碼都對不上，
  // 但更糟的是它會讓呼叫端以為有保護。
  return typeof hash === "string" && hash.trim() !== "" ? hash : null;
}
