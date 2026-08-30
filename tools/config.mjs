/**
 * 專案設定的讀取。
 *
 * 這個檔案只給本機工具（hub CLI 與 MCP server）使用，**不會**被 Worker
 * 打包——Worker 的進入點是 `src/index.js`，不會 import 到這裡。
 *
 * 教材化約束（2026-08-14 工作計畫）：不可寫死任何絕對路徑或專案名稱。
 * 專案根目錄由本檔位置推得，資料庫名稱由 `wrangler.jsonc` 讀出。
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 專案根目錄：本檔在 `<root>/tools/`，因此往上一層即為根。 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WRANGLER_CONFIG_PATH = join(PROJECT_ROOT, "wrangler.jsonc");

/**
 * 本專案要求的 Node.js 最低主版本。
 *
 * 放在這裡而不是各檢查腳本自己寫一份：`scripts/check-environment.mjs`（專案能不能跑）
 * 與 `scripts/check-tools.mjs`（工具齊不齊）都要用它。兩份數字遲早會分岔，
 * 而分岔的症狀是「一支說可以、另一支說不行」——使用者無從判斷該信哪個。
 */
export const MIN_NODE_MAJOR = 20;

/**
 * 去除 JSONC 的註解。
 *
 * `wrangler.jsonc` 帶有大量說明用註解，`JSON.parse` 無法直接處理。
 * 這個函式逐字元掃描而不是用正規表示式，因為註解符號可能合法地出現在
 * 字串裡（例如網址中的 `//`），正規表示式會把它一起砍掉。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (inString) {
      out += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      index += 2;

      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }

      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * 讀取並解析 `wrangler.jsonc`。
 *
 * @param {string} [path]
 * @returns {Record<string, any>}
 */
export function readWranglerConfig(path = WRANGLER_CONFIG_PATH) {
  const raw = readFileSync(path, "utf8");

  return JSON.parse(stripJsonComments(raw));
}

/**
 * 取出 Hub 的 D1 資料庫名稱。
 *
 * 名稱一律從設定檔讀取，不寫死——否則別人照著教材建自己的一套時，
 * 換了資料庫名稱就會壞掉，而且錯誤訊息不會指向真正的原因。
 *
 * @param {Record<string, any>} [config]
 * @returns {string}
 */
export function getDatabaseName(config = readWranglerConfig()) {
  const databases = config?.d1_databases;

  if (!Array.isArray(databases) || databases.length === 0) {
    throw new Error("wrangler.jsonc 中沒有設定 d1_databases。");
  }

  const name = databases[0]?.database_name;

  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("wrangler.jsonc 的 d1_databases[0].database_name 未設定。");
  }

  return name;
}

/**
 * 判斷遠端 D1 是否已經建立。
 *
 * 階段一沿用的佔位 UUID 全為 0 開頭的固定值，代表「只有本機模擬資料庫」。
 * 工具遇到這個值時必須明確告知，而不是讓 `--remote` 指令失敗後留下
 * 難以理解的錯誤訊息。
 *
 * @param {Record<string, any>} [config]
 * @returns {boolean}
 */
export function hasRemoteDatabase(config = readWranglerConfig()) {
  const id = config?.d1_databases?.[0]?.database_id;

  if (typeof id !== "string" || id.trim() === "") {
    return false;
  }

  // 判準為「前 8 碼全是 0」。真實的 Cloudflare UUID 出現這種開頭的機率是
  // 16 的 8 次方分之一，實務上不會誤判；而寫死整個佔位字串則會在有人
  // 換一個佔位值時失效。
  return !/^0{8}-/.test(id.trim());
}
