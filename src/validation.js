// @ts-check

/**
 * 輸入驗證，完全對應 2026-08-12 階段二詳細工作計畫第 11.1 節。
 *
 * 本層只驗證「格式」。像 category_id 或 tag_ids 是否真的存在於資料庫，
 * 屬於參照完整性，由 route 層查詢後判定。
 */

import { VISIBILITY_STATES } from "./visibility.js";

/**
 * 可見性的合法值來自 `visibility.js`，那裡是政策的單一事實來源。
 * 這裡刻意不另外列一份清單，避免兩邊各自修改而失去同步。
 */
export const VISIBILITIES = VISIBILITY_STATES;

export const PLATFORMS = Object.freeze([
  "cloudflare",
  "vercel",
  "supabase",
  "external",
]);

export const PROJECT_TYPES = Object.freeze([
  "static",
  "worker",
  "fullstack",
  "other",
]);

export const DATABASE_TYPES = Object.freeze([
  "none",
  "d1",
  "supabase",
  "other",
]);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const NAME_MAX = 100;
const SLUG_MAX = 80;
const DESCRIPTION_MAX = 1000;
const ICON_MAX = 32;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isString(value) {
  return typeof value === "string";
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {string | undefined}
 */
function readName(value, field, fields) {
  if (!isString(value)) {
    fields[field] = "必須是字串。";
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length < 1 || trimmed.length > NAME_MAX) {
    fields[field] = `長度必須介於 1 到 ${NAME_MAX} 個字元。`;
    return undefined;
  }

  return trimmed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {string | undefined}
 */
function readSlug(value, field, fields) {
  if (!isString(value)) {
    fields[field] = "必須是字串。";
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length < 1 || trimmed.length > SLUG_MAX) {
    fields[field] = `長度必須介於 1 到 ${SLUG_MAX} 個字元。`;
    return undefined;
  }

  if (!SLUG_PATTERN.test(trimmed)) {
    fields[field] = "只能使用小寫英文、數字與單一連字號，且不可用連字號開頭或結尾。";
    return undefined;
  }

  return trimmed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {string | undefined}
 */
function readDescription(value, field, fields) {
  if (!isString(value)) {
    fields[field] = "必須是字串。";
    return undefined;
  }

  if (value.length > DESCRIPTION_MAX) {
    fields[field] = `長度不可超過 ${DESCRIPTION_MAX} 個字元。`;
    return undefined;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {readonly string[]} allowed
 * @param {Record<string, string>} fields
 * @returns {string | undefined}
 */
function readEnum(value, field, allowed, fields) {
  if (!isString(value) || !allowed.includes(value)) {
    fields[field] = `只能是下列其中之一：${allowed.join("、")}。`;
    return undefined;
  }

  return value;
}

/**
 * URL 欄位：允許 null 或空字串（代表未設定），有值時只接受 https。
 *
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {string | null | undefined}
 */
function readHttpsUrl(value, field, fields) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (!isString(value)) {
    fields[field] = "必須是字串或 null。";
    return undefined;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    fields[field] = "不是有效的網址。";
    return undefined;
  }

  if (parsed.protocol !== "https:") {
    fields[field] = "只接受 https 開頭的網址。";
    return undefined;
  }

  return value;
}

/**
 * 本站自己的縮圖路徑。
 *
 * `/media/thumbnails/…` 是上傳按鈕與 `hub thumbnail` 存進 D1 後產生的網址；
 * `/thumbnails/…` 是 2026-08-30 之前 `hub ship` 複製成靜態檔的舊制路徑，
 * 線上仍有專案指向它，所以必須繼續接受。
 */
const OWN_THUMBNAIL_PATH = /^\/(?:media\/thumbnails|thumbnails)\/[^/\\?#]+\.(?:png|jpe?g|webp|avif)$/i;

/**
 * 縮圖網址：比一般 URL 欄位多接受**本站自己的相對路徑**。
 *
 * ## 為什麼要另外寫一個（2026-08-30 使用者實測後才發現）
 *
 * `readHttpsUrl()` 要求絕對的 https 網址，而上傳 API 寫回資料庫、也填回表單的
 * 是 `/media/thumbnails/<uuid>.png` 這種相對路徑。結果是：
 *
 *   按下「上傳圖片」→ 201 成功、欄位自動填入 → 按下「儲存」→ **驗證失敗**
 *   「不是有效的網址」
 *
 * 圖其實已經存進資料庫、專案也已經指過去了（上傳那一步自己做了 UPDATE），
 * 但使用者看到的是一個紅字錯誤，多半會以為整件事沒成功。
 *
 * ## 為什麼用白名單而不是「開頭是斜線就放行」
 *
 * `//evil.com/x.png` 開頭也是斜線，但瀏覽器會把它當成**絕對網址**（協定相對），
 * 於是變成從別人的網域載入圖片。`/\evil.com` 在部分解析器裡有同樣效果。
 * 只認這個系統自己會產生的兩種形狀，這類問題全部不存在。
 *
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {string | null | undefined}
 */
function readThumbnailUrl(value, field, fields) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (isString(value) && OWN_THUMBNAIL_PATH.test(value)) {
    return value;
  }

  if (isString(value) && value.startsWith("/")) {
    // 走到這裡代表是斜線開頭但形狀不對。給出具體的形狀，不要只說「不是有效的網址」。
    fields[field] = "本站的圖片路徑只接受 /media/thumbnails/… 或 /thumbnails/…（png、jpg、webp、avif）。";
    return undefined;
  }

  return readHttpsUrl(value, field, fields);
}

/**
 * 給測試與其他呼叫端單獨核對網址協定用途，不牽涉必填、長度等其他規則。
 * 只接受 http 與 https（2026-08-27 使用者裁決）——推薦連結常包含校內系統
 * 的內部網址（例如教務系統、證照系統），只收 https 會直接擋掉合法情境。
 * 這一點與 `readHttpsUrl`（給 projects 用，只收 https）刻意不同。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHttpOrHttpsUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 推薦連結的網址欄位：必填，協定規則見 `isHttpOrHttpsUrl`。
 *
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {string | undefined}
 */
function readLinkUrl(value, field, fields) {
  if (!isString(value) || value.trim().length === 0) {
    fields[field] = "必須是網址字串。";
    return undefined;
  }

  const trimmed = value.trim();

  if (!isHttpOrHttpsUrl(trimmed)) {
    fields[field] = "只接受 http 或 https 開頭的有效網址。";
    return undefined;
  }

  return trimmed;
}

/**
 * 推薦連結的 emoji 圖示。允許空字串（代表沒有圖示），只做長度上限檢查——
 * 不驗證「是不是真的 emoji」，那需要 Unicode 屬性判斷，且使用者貼錯了
 * 頂多顯示不出圖示，不構成安全或資料完整性問題，不值得增加驗證複雜度。
 *
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {string | undefined}
 */
function readIcon(value, field, fields) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (!isString(value)) {
    fields[field] = "必須是字串。";
    return undefined;
  }

  if (value.length > ICON_MAX) {
    fields[field] = `長度不可超過 ${ICON_MAX} 個字元。`;
    return undefined;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {number | null | undefined}
 */
function readOptionalId(value, field, fields) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fields[field] = "必須是正整數或 null。";
    return undefined;
  }

  return value;
}

/**
 * tag_ids：陣列、去重、每項必須是正整數。存在性由 route 層檢查。
 *
 * @param {unknown} value
 * @param {string} field
 * @param {Record<string, string>} fields
 * @returns {number[] | undefined}
 */
function readTagIds(value, field, fields) {
  if (value === null || value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    fields[field] = "必須是陣列。";
    return undefined;
  }

  /** @type {Set<number>} */
  const unique = new Set();

  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1) {
      fields[field] = "每一個項目都必須是正整數。";
      return undefined;
    }

    unique.add(item);
  }

  return [...unique];
}

/**
 * 建立 Project 的完整驗證。缺少必填欄位即失敗。
 *
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, fields: Record<string, string> }}
 */
export function validateProjectCreate(input) {
  /** @type {Record<string, string>} */
  const fields = {};

  const name = readName(input.name, "name", fields);
  const slug = readSlug(input.slug, "slug", fields);
  const visibility = readEnum(input.visibility, "visibility", VISIBILITIES, fields);
  const platform = readEnum(input.platform, "platform", PLATFORMS, fields);

  const projectType = input.project_type === undefined
    ? "other"
    : readEnum(input.project_type, "project_type", PROJECT_TYPES, fields);

  const databaseType = input.database_type === undefined
    ? "none"
    : readEnum(input.database_type, "database_type", DATABASE_TYPES, fields);

  const description = input.description === undefined
    ? ""
    : readDescription(input.description, "description", fields);

  const repositoryUrl = readHttpsUrl(input.repository_url, "repository_url", fields);
  const deploymentUrl = readHttpsUrl(input.deployment_url, "deployment_url", fields);
  const thumbnailUrl = readThumbnailUrl(input.thumbnail_url, "thumbnail_url", fields);
  const categoryId = readOptionalId(input.category_id, "category_id", fields);
  const tagIds = readTagIds(input.tag_ids, "tag_ids", fields);

  let workerName = null;

  if (input.worker_name !== undefined && input.worker_name !== null) {
    if (!isString(input.worker_name) || input.worker_name.trim().length > NAME_MAX) {
      fields.worker_name = `必須是字串，長度不可超過 ${NAME_MAX} 個字元。`;
    } else {
      workerName = input.worker_name.trim() === "" ? null : input.worker_name.trim();
    }
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      name,
      slug,
      description,
      visibility,
      category_id: categoryId,
      repository_url: repositoryUrl,
      worker_name: workerName,
      platform,
      deployment_url: deploymentUrl,
      project_type: projectType,
      database_type: databaseType,
      thumbnail_url: thumbnailUrl,
      tag_ids: tagIds,
    },
  };
}

/**
 * PATCH 驗證：只處理 payload 中「明確出現」的欄位。
 *
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, fields: Record<string, string> }}
 */
export function validateProjectPatch(input) {
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {Record<string, unknown>} */
  const value = {};

  if ("name" in input) {
    const name = readName(input.name, "name", fields);
    if (name !== undefined) value.name = name;
  }

  if ("slug" in input) {
    const slug = readSlug(input.slug, "slug", fields);
    if (slug !== undefined) value.slug = slug;
  }

  if ("description" in input) {
    const description = readDescription(input.description, "description", fields);
    if (description !== undefined) value.description = description;
  }

  if ("visibility" in input) {
    const visibility = readEnum(input.visibility, "visibility", VISIBILITIES, fields);
    if (visibility !== undefined) value.visibility = visibility;
  }

  if ("platform" in input) {
    const platform = readEnum(input.platform, "platform", PLATFORMS, fields);
    if (platform !== undefined) value.platform = platform;
  }

  if ("project_type" in input) {
    const projectType = readEnum(input.project_type, "project_type", PROJECT_TYPES, fields);
    if (projectType !== undefined) value.project_type = projectType;
  }

  if ("database_type" in input) {
    const databaseType = readEnum(input.database_type, "database_type", DATABASE_TYPES, fields);
    if (databaseType !== undefined) value.database_type = databaseType;
  }

  if ("repository_url" in input) {
    const url = readHttpsUrl(input.repository_url, "repository_url", fields);
    if (url !== undefined) value.repository_url = url;
  }

  if ("deployment_url" in input) {
    const url = readHttpsUrl(input.deployment_url, "deployment_url", fields);
    if (url !== undefined) value.deployment_url = url;
  }

  if ("thumbnail_url" in input) {
    const url = readThumbnailUrl(input.thumbnail_url, "thumbnail_url", fields);
    if (url !== undefined) value.thumbnail_url = url;
  }

  if ("category_id" in input) {
    const categoryId = readOptionalId(input.category_id, "category_id", fields);
    if (categoryId !== undefined) value.category_id = categoryId;
  }

  if ("worker_name" in input) {
    if (input.worker_name === null || input.worker_name === "") {
      value.worker_name = null;
    } else if (!isString(input.worker_name) || input.worker_name.trim().length > NAME_MAX) {
      fields.worker_name = `必須是字串，長度不可超過 ${NAME_MAX} 個字元。`;
    } else {
      value.worker_name = input.worker_name.trim();
    }
  }

  if ("tag_ids" in input) {
    const tagIds = readTagIds(input.tag_ids, "tag_ids", fields);
    if (tagIds !== undefined) value.tag_ids = tagIds;
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  if (Object.keys(value).length === 0) {
    return { ok: false, fields: { _: "沒有任何可更新的欄位。" } };
  }

  return { ok: true, value };
}

/**
 * Category／Tag 共用的驗證。Tag 沒有 description 與 sort_order。
 *
 * @param {Record<string, unknown>} input
 * @param {{ withDescription: boolean, withSortOrder: boolean, partial: boolean }} options
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, fields: Record<string, string> }}
 */
export function validateTaxonomy(input, options) {
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {Record<string, unknown>} */
  const value = {};

  if (!options.partial || "name" in input) {
    const name = readName(input.name, "name", fields);
    if (name !== undefined) value.name = name;
  }

  // 代稱是選填的：使用者只需要輸入中文名稱，沒填時由呼叫端自動產生。
  // 代稱只用於網址，而網址不適合放中文，因此不能直接沿用名稱。
  if ("slug" in input && input.slug !== null && input.slug !== "") {
    const slug = readSlug(input.slug, "slug", fields);
    if (slug !== undefined) value.slug = slug;
  }

  if (options.withDescription && (!options.partial || "description" in input)) {
    const description = input.description === undefined
      ? ""
      : readDescription(input.description, "description", fields);
    if (description !== undefined) value.description = description;
  }

  if (options.withSortOrder && (!options.partial || "sort_order" in input)) {
    if (input.sort_order === undefined) {
      value.sort_order = 0;
    } else if (typeof input.sort_order !== "number" || !Number.isInteger(input.sort_order)) {
      fields.sort_order = "必須是整數。";
    } else {
      value.sort_order = input.sort_order;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  if (options.partial && Object.keys(value).length === 0) {
    return { ok: false, fields: { _: "沒有任何可更新的欄位。" } };
  }

  return { ok: true, value };
}

/**
 * 建立推薦連結的完整驗證。缺少必填欄位即失敗。
 *
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, fields: Record<string, string> }}
 */
export function validateLinkCreate(input) {
  /** @type {Record<string, string>} */
  const fields = {};

  const name = readName(input.name, "name", fields);
  const url = readLinkUrl(input.url, "url", fields);

  const description = input.description === undefined
    ? ""
    : readDescription(input.description, "description", fields);

  const icon = readIcon(input.icon, "icon", fields);
  const categoryId = readOptionalId(input.category_id, "category_id", fields);

  let sortOrder = 0;

  if (input.sort_order !== undefined) {
    if (typeof input.sort_order !== "number" || !Number.isInteger(input.sort_order)) {
      fields.sort_order = "必須是整數。";
    } else {
      sortOrder = input.sort_order;
    }
  }

  let isListed = true;

  if (input.is_listed !== undefined) {
    if (typeof input.is_listed !== "boolean") {
      fields.is_listed = "必須是布林值。";
    } else {
      isListed = input.is_listed;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      name,
      url,
      description,
      icon,
      category_id: categoryId,
      sort_order: sortOrder,
      is_listed: isListed,
    },
  };
}

/**
 * PATCH 驗證：只處理 payload 中「明確出現」的欄位（與 `validateProjectPatch` 同慣例）。
 *
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, fields: Record<string, string> }}
 */
export function validateLinkPatch(input) {
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {Record<string, unknown>} */
  const value = {};

  if ("name" in input) {
    const name = readName(input.name, "name", fields);
    if (name !== undefined) value.name = name;
  }

  if ("url" in input) {
    const url = readLinkUrl(input.url, "url", fields);
    if (url !== undefined) value.url = url;
  }

  if ("description" in input) {
    const description = readDescription(input.description, "description", fields);
    if (description !== undefined) value.description = description;
  }

  if ("icon" in input) {
    const icon = readIcon(input.icon, "icon", fields);
    if (icon !== undefined) value.icon = icon;
  }

  if ("category_id" in input) {
    const categoryId = readOptionalId(input.category_id, "category_id", fields);
    if (categoryId !== undefined) value.category_id = categoryId;
  }

  if ("sort_order" in input) {
    if (typeof input.sort_order !== "number" || !Number.isInteger(input.sort_order)) {
      fields.sort_order = "必須是整數。";
    } else {
      value.sort_order = input.sort_order;
    }
  }

  if ("is_listed" in input) {
    if (typeof input.is_listed !== "boolean") {
      fields.is_listed = "必須是布林值。";
    } else {
      value.is_listed = input.is_listed;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  if (Object.keys(value).length === 0) {
    return { ok: false, fields: { _: "沒有任何可更新的欄位。" } };
  }

  return { ok: true, value };
}
