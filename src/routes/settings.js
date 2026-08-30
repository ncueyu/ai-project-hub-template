// @ts-check

import {
  internalError,
  jsonData,
  jsonError,
  methodNotAllowed,
  readJsonBody,
  rejectCrossSite,
} from "../http.js";
import {
  GALLERY_LAYOUT_KEY,
  GALLERY_LAYOUTS,
  getGalleryLayout,
  isValidGalleryLayout,
  setGalleryLayout,
  SITE_THEME_KEY,
  SITE_THEMES,
  getSiteTheme,
  isValidSiteTheme,
  setSiteTheme,
  SITE_NAME_KEY,
  SITE_NAME_MAX_LENGTH,
  getSiteName,
  isValidSiteName,
  setSiteName,
  SITE_LOGO_KEY,
  SITE_LOGOS,
  getSiteLogo,
  isValidSiteLogo,
  setSiteLogo,
} from "../repositories/settings.js";

const MUTATING_METHODS = new Set(["PATCH"]);

/** 這條路由目前認得的鍵——白名單，不是任意 key 讀寫（見下方註解）。 */
const KNOWN_SETTINGS_KEYS = new Set(["gallery_layout", "site_name", "site_logo", "site_theme"]);

/**
 * 管理用站台設定 API。
 *
 * `site_settings` 本身是通用的 key-value 表（見 migrations/0002），但這條路由
 * 只認白名單裡的鍵，不做成通用的「任意 key 讀寫」——那會需要另外設計 key
 * 的白名單與格式驗證，多一個鍵就多加一項白名單，比預先設計一整層通用機制
 * 務實。2026-08-28 新增 `site_name`（站名，見同日工作計畫 Part A）；
 * 同日再新增 `site_logo`（品牌圖示，見 2026-08-28-工作計畫-主畫面改造.md
 * Part A）。
 *
 * 注意：這裡是「管理者寫入站名／圖示」的端點（受 `src/admin-gate.js` 密碼
 * 閘道保護）。公開頁面讀取這些設定走的是另一個不需要登入的唯讀端點
 * `/api/site`（見 `src/routes/site.js`），刻意分開——`/api/site` 只回白
 * 名單內的公開欄位，不能成為任何其他設定的洩漏出口。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {string[]} segments `/api/settings` 之後的路徑片段
 * @returns {Promise<Response>}
 */
export async function handleSettings(request, db, segments) {
  if (segments.length !== 1 || !KNOWN_SETTINGS_KEYS.has(segments[0])) {
    return jsonError(404, "NOT_FOUND", "Resource not found.");
  }

  const key = segments[0];

  if (MUTATING_METHODS.has(request.method)) {
    const rejected = rejectCrossSite(request);

    if (rejected) {
      return rejected;
    }
  }

  try {
    if (request.method === "GET" || request.method === "HEAD") {
      if (key === "site_name") {
        return jsonData({ key: SITE_NAME_KEY, value: await getSiteName(db) });
      }
      if (key === "site_logo") {
        return jsonData({ key: SITE_LOGO_KEY, value: await getSiteLogo(db) });
      }
      if (key === "site_theme") {
        return jsonData({ key: SITE_THEME_KEY, value: await getSiteTheme(db) });
      }
      return jsonData({ key: GALLERY_LAYOUT_KEY, value: await getGalleryLayout(db) });
    }

    if (request.method === "PATCH") {
      if (key === "site_name") {
        return await handleSiteNamePatch(request, db);
      }
      if (key === "site_logo") {
        return await handleSiteLogoPatch(request, db);
      }
      if (key === "site_theme") {
        return await handleSiteThemePatch(request, db);
      }
      return await handleGalleryLayoutPatch(request, db);
    }

    return methodNotAllowed(["GET", "HEAD", "PATCH"]);
  } catch (error) {
    console.log(JSON.stringify({
      action: "settings.internal_error",
      status: 500,
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }));
    return internalError();
  }
}

/**
 * @param {Request} request
 * @param {D1Database} db
 * @returns {Promise<Response>}
 */
async function handleGalleryLayoutPatch(request, db) {
  const body = await readJsonBody(request);

  if (body.response) {
    return body.response;
  }

  const value = body.value.value;

  if (typeof value !== "string" || !isValidGalleryLayout(value)) {
    return jsonError(400, "VALIDATION_FAILED", "Layout value is invalid.", {
      value: `只能是下列其中之一：${GALLERY_LAYOUTS.join("、")}。`,
    });
  }

  const updated = await setGalleryLayout(db, value, new Date().toISOString());

  if (!updated) {
    return internalError();
  }

  return jsonData(updated);
}

/**
 * @param {Request} request
 * @param {D1Database} db
 * @returns {Promise<Response>}
 */
async function handleSiteNamePatch(request, db) {
  const body = await readJsonBody(request);

  if (body.response) {
    return body.response;
  }

  const value = body.value.value;

  if (typeof value !== "string" || !isValidSiteName(value)) {
    return jsonError(400, "VALIDATION_FAILED", "Site name is invalid.", {
      value: `不能是空字串，長度上限 ${SITE_NAME_MAX_LENGTH} 個字元。`,
    });
  }

  const updated = await setSiteName(db, value, new Date().toISOString());

  if (!updated) {
    return internalError();
  }

  return jsonData(updated);
}

/**
 * @param {Request} request
 * @param {D1Database} db
 * @returns {Promise<Response>}
 */
async function handleSiteLogoPatch(request, db) {
  const body = await readJsonBody(request);

  if (body.response) {
    return body.response;
  }

  const value = body.value.value;

  if (typeof value !== "string" || !isValidSiteLogo(value)) {
    return jsonError(400, "VALIDATION_FAILED", "Logo value is invalid.", {
      value: `只能是下列其中之一：${SITE_LOGOS.join("、")}。`,
    });
  }

  const updated = await setSiteLogo(db, value, new Date().toISOString());

  if (!updated) {
    return internalError();
  }

  return jsonData(updated);
}

/**
 * 配色風格（2026-08-29 新增）。與上面三個 PATCH 同一套模式。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @returns {Promise<Response>}
 */
async function handleSiteThemePatch(request, db) {
  const body = await readJsonBody(request);

  if (body.response) {
    return body.response;
  }

  const value = body.value.value;

  if (typeof value !== "string" || !isValidSiteTheme(value)) {
    return jsonError(400, "VALIDATION_FAILED", "Theme value is invalid.", {
      value: `只能是下列其中之一：${SITE_THEMES.join("、")}。`,
    });
  }

  const updated = await setSiteTheme(db, value, new Date().toISOString());

  if (!updated) {
    return internalError();
  }

  return jsonData(updated);
}
