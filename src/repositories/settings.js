// @ts-check

/**
 * 站台設定的資料存取層。
 *
 * `site_settings` 是通用的 key-value 表（理由見
 * `migrations/0002_links_and_settings.sql` 檔頭：本次只用一個鍵，但下一個
 * 主線項目——站名設定——也需要站台層級設定，key-value 讓那時只需要多加
 * 一列資料，不必再修改 schema）。本次只實作 `gallery_layout` 這一個鍵。
 *
 * 合法值清單做成單一來源常數（比照 `src/visibility.js` 的
 * `GALLERY_LISTED_STATES` 模式），驗證層與這裡共用同一份，避免兩邊
 * 各自維護一份清單、漏改的那一次不會有任何錯誤訊息。
 *
 * 2026-08-28 新增 `site_name`：範本要抽給其他老師使用，站名不能寫死成
 * 作者的名字（詳見 `2026-08-27-工作計畫-站名與hub-init.md` 第三節 Part A）。
 * 沿用同一張 key-value 表，只是多一列資料，不需要新的 migration。
 */

/** `site_settings` 裡代表版面風格的鍵名。 */
export const GALLERY_LAYOUT_KEY = "gallery_layout";

/**
 * 四種版面風格，順序固定——單一事實來源。
 *
 * 2026-08-28 新增 `rows`（分類橫排：一個分類一排，橫向捲動，見
 * `2026-08-28-工作計畫-主畫面改造.md` Part E／3-3 節）。前端 `public/app.js`
 * 有一份必要的重複清單（前端無法 import 後端模組，該處已註解說明），
 * 新增版面時兩處都要同步修改，漏一處會出現「後台選得到但前端不認」。
 */
export const GALLERY_LAYOUTS = Object.freeze(["hero", "grid", "list", "rows"]);

/**
 * 空殼與「讀不到設定值」時的預設風格。
 * 2026-08-27 裁決：grid（整齊小卡）在有縮圖與沒有縮圖的專案之間最中庸，
 * 新使用者不會第一眼看到破圖或太過樸素的清單。
 */
export const DEFAULT_GALLERY_LAYOUT = "grid";

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidGalleryLayout(value) {
  return GALLERY_LAYOUTS.includes(value);
}

/**
 * 讀取版面設定。任何讀不到的情況——表是空的、鍵不存在、值不合法——一律
 * 回預設值，不拋錯：展示中心不能因為一筆設定缺席就整頁掛掉。
 *
 * @param {D1Database} db
 * @returns {Promise<string>}
 */
export async function getGalleryLayout(db) {
  const row = await db
    .prepare("SELECT value FROM site_settings WHERE key = ?")
    .bind(GALLERY_LAYOUT_KEY)
    .first();

  const value = row?.value;

  return typeof value === "string" && isValidGalleryLayout(value)
    ? value
    : DEFAULT_GALLERY_LAYOUT;
}

/**
 * 寫入版面設定。呼叫端（route 層）必須先驗證 value 合法，這裡再擋一次——
 * `site_settings` 是泛用表，資料庫層沒有 CHECK 約束能替它把關，
 * 防禦式重複檢查比信任呼叫端省事。
 *
 * @param {D1Database} db
 * @param {string} value
 * @param {string} now ISO-8601 UTC
 * @returns {Promise<{ key: string, value: string, updated_at: string } | null>} 值不合法時回 null
 */
export async function setGalleryLayout(db, value, now) {
  if (!isValidGalleryLayout(value)) {
    return null;
  }

  await db
    .prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(GALLERY_LAYOUT_KEY, value, now)
    .run();

  return { key: GALLERY_LAYOUT_KEY, value, updated_at: now };
}

/** `site_settings` 裡代表配色風格的鍵名。 */
export const SITE_THEME_KEY = "site_theme";

/**
 * 四套配色風格，順序固定——單一事實來源。
 *
 * 來源：`AI-Project-Hub-三種網站風格與主卡搭配.md`（2026-08-29）。
 * `zero` 是本專案原本的配色，保留成一個選項而不是丟掉——已經在用的站台
 * 不該因為一次改版就被換掉外觀（2026-08-29 使用者裁定）。
 *
 * 與版面風格一樣，`public/site-footer.js` 有一份必要的重複清單
 * （前端無法 import 後端模組），新增風格時兩處都要改。
 */
export const SITE_THEMES = Object.freeze(["zero", "one", "two", "three"]);

/**
 * 預設風格。
 *
 * 2026-08-29 裁定 `zero`（現行配色）：預設值換掉的話，所有既有站台
 * 都會在下一次載入時變臉。預設維持現狀、想換的人自己選，是比較有禮貌的作法。
 */
export const DEFAULT_SITE_THEME = "zero";

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidSiteTheme(value) {
  return SITE_THEMES.includes(value);
}

/**
 * 讀取配色設定。與 `getGalleryLayout()` 同一套規則：讀不到就回預設值，不拋錯。
 *
 * @param {D1Database} db
 * @returns {Promise<string>}
 */
export async function getSiteTheme(db) {
  const row = await db
    .prepare("SELECT value FROM site_settings WHERE key = ?")
    .bind(SITE_THEME_KEY)
    .first();

  const value = row?.value;

  return typeof value === "string" && isValidSiteTheme(value) ? value : DEFAULT_SITE_THEME;
}

/**
 * 寫入配色設定。與 `setGalleryLayout()` 同一套防禦式重複檢查。
 *
 * @param {D1Database} db
 * @param {string} value
 * @param {string} now ISO-8601 UTC
 * @returns {Promise<{ key: string, value: string, updated_at: string } | null>} 值不合法時回 null
 */
export async function setSiteTheme(db, value, now) {
  if (!isValidSiteTheme(value)) {
    return null;
  }

  await db
    .prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(SITE_THEME_KEY, value, now)
    .run();

  return { key: SITE_THEME_KEY, value, updated_at: now };
}

// ---------------------------------------------------------------------------
// site_name
// ---------------------------------------------------------------------------

/** `site_settings` 裡代表站名的鍵名。 */
export const SITE_NAME_KEY = "site_name";

/**
 * 站名長度上限。範本要交給其他老師使用，不限制長度的話，過長的站名會在
 * `brand-subtitle`／`<title>` 等固定寬度的位置把版面撐壞。60 字元足夠容納
 * 中英文混排的長站名，同時仍是一個能一眼看完的長度。
 */
export const SITE_NAME_MAX_LENGTH = 60;

/**
 * 中性預設值：這是「範本」而非某人的個人網站，未設定站名前不能顯示作者的
 * 名字（原本寫死的「AI Project Hub」），也不能顯示空白——中性值本身就是
 * 可用的展示文字。
 */
export const DEFAULT_SITE_NAME = "專案展示中心";

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidSiteName(value) {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();

  // 空字串（含全空白）與超長站名都拒絕；長度規則與 `src/validation.js`
  // 的 `readName` 同一種寫法（trim 後量長度），保持全專案一致。
  return trimmed.length > 0 && trimmed.length <= SITE_NAME_MAX_LENGTH;
}

/**
 * 讀取站名。讀不到、或（理論上不該發生但仍防禦性檢查的）非法值，一律回
 * 中性預設值，不拋錯——這是公開端點會直接呼叫的函式，不能因為一筆設定
 * 缺席就讓首頁的品牌區塊壞掉。
 *
 * @param {D1Database} db
 * @returns {Promise<string>}
 */
export async function getSiteName(db) {
  const row = await db
    .prepare("SELECT value FROM site_settings WHERE key = ?")
    .bind(SITE_NAME_KEY)
    .first();

  const value = row?.value;

  return typeof value === "string" && isValidSiteName(value) ? value.trim() : DEFAULT_SITE_NAME;
}

/**
 * 寫入站名。呼叫端（route 層）必須先驗證，這裡再擋一次，理由與
 * `setGalleryLayout` 相同：`site_settings` 是泛用表，沒有 CHECK 約束能
 * 替它把關。寫入前一律 trim，避免使用者不小心留下前後空白。
 *
 * @param {D1Database} db
 * @param {string} value
 * @param {string} now ISO-8601 UTC
 * @returns {Promise<{ key: string, value: string, updated_at: string } | null>} 值不合法時回 null
 */
export async function setSiteName(db, value, now) {
  if (!isValidSiteName(value)) {
    return null;
  }

  const trimmed = value.trim();

  await db
    .prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(SITE_NAME_KEY, trimmed, now)
    .run();

  return { key: SITE_NAME_KEY, value: trimmed, updated_at: now };
}

// ---------------------------------------------------------------------------
// site_logo
// ---------------------------------------------------------------------------

/** `site_settings` 裡代表品牌圖示的鍵名。 */
export const SITE_LOGO_KEY = "site_logo";

/**
 * 四個預設 logo 的代號，順序固定——單一事實來源，比照 `GALLERY_LAYOUTS`
 * 的模式。**只接受這四個值**：這個值最終會被前端組成
 * `/logos/<value>.png` 的圖片路徑，不做成任意字串是為了不讓這個欄位變成
 * 任意路徑寫入的入口（見 2026-08-28-工作計畫-主畫面改造.md Part A）。
 * 檔案本身在 `public/logos/logo-01.png`～`logo-04.png`。
 */
export const SITE_LOGOS = Object.freeze(["logo-01", "logo-02", "logo-03", "logo-04"]);

/** 空殼與「讀不到設定值」時的預設 logo：四張裡的第一張。 */
export const DEFAULT_SITE_LOGO = "logo-01";

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidSiteLogo(value) {
  return typeof value === "string" && SITE_LOGOS.includes(value);
}

/**
 * 讀取品牌圖示設定。讀不到、或（理論上不該發生但仍防禦性檢查的）非法值，
 * 一律回預設值，不拋錯——原則與 `getGalleryLayout`／`getSiteName` 相同：
 * 這是公開端點會直接呼叫的函式，不能因為一筆設定缺席就讓品牌區塊壞掉。
 *
 * @param {D1Database} db
 * @returns {Promise<string>}
 */
export async function getSiteLogo(db) {
  const row = await db
    .prepare("SELECT value FROM site_settings WHERE key = ?")
    .bind(SITE_LOGO_KEY)
    .first();

  const value = row?.value;

  return isValidSiteLogo(value) ? value : DEFAULT_SITE_LOGO;
}

/**
 * 寫入品牌圖示設定。呼叫端（route 層）必須先驗證 value 合法，這裡再擋一次，
 * 理由與 `setGalleryLayout` 相同：`site_settings` 是泛用表，沒有 CHECK
 * 約束能替它把關。
 *
 * @param {D1Database} db
 * @param {string} value
 * @param {string} now ISO-8601 UTC
 * @returns {Promise<{ key: string, value: string, updated_at: string } | null>} 值不合法時回 null
 */
export async function setSiteLogo(db, value, now) {
  if (!isValidSiteLogo(value)) {
    return null;
  }

  await db
    .prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(SITE_LOGO_KEY, value, now)
    .run();

  return { key: SITE_LOGO_KEY, value, updated_at: now };
}
