// @ts-check

/**
 * 專案 Manifest（`project-hub.json`）的定義與驗證。
 *
 * 依 2026-08-14 階段三工作計畫 TASK A-1：第一版欄位越少越好，且欄位名稱
 * 與 D1 的 projects 資料表一致，避免出現「同一件事兩種叫法」。
 *
 * 格式規則（長度、slug 樣式、列舉值）刻意**不在這裡重寫**，一律委派給
 * `validation.js` — 那裡是格式規則的單一事實來源。這個檔案只負責三件
 * Manifest 特有的事：
 *   1. 決定哪些欄位屬於 Manifest（白名單）
 *   2. 補上 Manifest 專屬的預設值
 *   3. 把驗證結果收斂成 Manifest 的形狀
 */

import { validateProjectCreate } from "../validation.js";

/** Manifest 檔案的固定檔名。 */
export const MANIFEST_FILENAME = "project-hub.json";

/**
 * Manifest 允許出現的欄位。
 *
 * 這是白名單而非黑名單：Manifest 是人手寫的檔案，拼錯欄位名（例如把
 * `platform` 打成 `plaform`）若被靜默忽略，使用者會看到「設定沒有生效」
 * 卻找不到原因。寧可直接報錯指出哪個欄位不認得。
 */
export const MANIFEST_FIELDS = Object.freeze([
  "name",
  "slug",
  "visibility",
  "platform",
  "project_type",
  "database_type",
]);

/**
 * Manifest 未填欄位時的預設值。
 *
 * visibility 預設為 **private** 是刻意的：忘記填的結果應該是「沒有人看得到」，
 * 而不是「全世界都看得到」。方向與 `ADMIN_ENABLED` 預設關閉一致——
 * 遺漏設定的代價應該是功能少一點，不是門戶大開。
 */
export const MANIFEST_DEFAULTS = Object.freeze({
  visibility: "private",
  platform: "cloudflare",
  project_type: "other",
  database_type: "none",
});

/**
 * 驗證 Manifest 內容。
 *
 * @param {unknown} input 已解析的 JSON 物件
 * @returns {{ ok: true, value: Record<string, string> } | { ok: false, fields: Record<string, string> }}
 */
export function validateManifest(input) {
  /** @type {Record<string, string>} */
  const fields = {};

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      fields: { _: `${MANIFEST_FILENAME} 的內容必須是一個 JSON 物件。` },
    };
  }

  const source = /** @type {Record<string, unknown>} */ (input);

  for (const key of Object.keys(source)) {
    if (!MANIFEST_FIELDS.includes(key)) {
      fields[key] = `不是 ${MANIFEST_FILENAME} 認得的欄位。可用欄位：${MANIFEST_FIELDS.join("、")}。`;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  // 交給 validation.js 做實際的格式檢查。這裡先補上預設值，因為
  // validateProjectCreate 對 visibility 與 platform 是「必填無預設」。
  const merged = { ...MANIFEST_DEFAULTS, ...source };
  const result = validateProjectCreate(merged);

  if (!result.ok) {
    // 只回報 Manifest 有的欄位。validateProjectCreate 可能對 Manifest
    // 根本不接受的欄位（例如 tag_ids）有意見，那些不該出現在錯誤訊息裡。
    /** @type {Record<string, string>} */
    const relevant = {};

    for (const key of MANIFEST_FIELDS) {
      if (result.fields[key]) {
        relevant[key] = result.fields[key];
      }
    }

    return {
      ok: false,
      fields: Object.keys(relevant).length > 0 ? relevant : result.fields,
    };
  }

  /** @type {Record<string, string>} */
  const value = {};

  for (const key of MANIFEST_FIELDS) {
    value[key] = /** @type {string} */ (result.value[key]);
  }

  return { ok: true, value };
}

/**
 * 去除開頭的 BOM（U+FEFF）。
 *
 * 以字碼比對而不是寫進正規表示式：BOM 在原始碼裡是看不見的字元，
 * 寫在正規表示式中會讓下一個維護者看到一個「空的」樣式，無從判斷用意。
 *
 * @param {string} text
 * @returns {string}
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * 解析 Manifest 檔案的文字內容。
 *
 * JSON 解析失敗與欄位錯誤分開回報：前者是「檔案打壞了」，後者是「內容不對」，
 * 使用者要採取的行動不同。
 *
 * @param {string} text
 * @returns {{ ok: true, value: Record<string, string> } | { ok: false, fields: Record<string, string> }}
 */
export function parseManifest(text) {
  let parsed;

  try {
    // 先去掉 BOM。Windows 的記事本與 PowerShell 的 Out-File 預設都會寫入
    // UTF-8 BOM，而 JSON.parse 會因此丟出「Unexpected token」——錯誤訊息
    // 指向一個看不見的字元，使用者幾乎不可能自行查出原因。
    parsed = JSON.parse(stripBom(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      fields: { _: `${MANIFEST_FILENAME} 不是有效的 JSON：${detail}` },
    };
  }

  return validateManifest(parsed);
}
