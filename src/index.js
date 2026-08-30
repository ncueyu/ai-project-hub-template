// @ts-check

import { jsonError, methodNotAllowed, requireDatabase } from "./http.js";
import { handleGallery } from "./routes/gallery.js";
import { handleLinks } from "./routes/links.js";
import { handleSettings } from "./routes/settings.js";
import { handleSite } from "./routes/site.js";
import { handleProjects, handleSetPrimary } from "./routes/projects.js";
import { handleTaxonomy } from "./routes/taxonomy.js";
import { handleDeployments } from "./routes/deployments.js";
import { handlePolicy } from "./routes/policies.js";
import { handleThumbnailFetch, handleThumbnailUpload } from "./routes/thumbnails.js";
import { wantsHtml } from "./access-gate/protected-worker.js";
import {
  ADMIN_LOGIN_PATH,
  ADMIN_LOGOUT_PATH,
  handleAdminLogin,
  handleAdminLogout,
  isAdminAuthenticated,
  renderAdminLoginPage,
} from "./admin-gate.js";

/**
 * @typedef {import("./http.js").Env & {
 *   ADMIN_ENABLED?: string,
 *   SESSION_SIGNING_KEY?: string,
 *   ADMIN_PASSWORD_HASH?: string,
 * }} Env
 */

/**
 * 管理介面與管理 API 的路徑前綴。
 *
 * 這些路徑會讀寫全部專案資料，正式環境由 `src/admin-gate.js` 的密碼閘道保護
 * （2026-08-25 起；原計畫是 Cloudflare Access，放棄理由見
 * `2026-08-25-工作計畫.md`）。在 `ADMIN_ENABLED` 尚未開啟之前，寧可整個關閉，
 * 也不要讓它們無防護地對外——這一層跟密碼閘道是兩道獨立的防線，缺一不可。
 */
const ADMIN_API_RESOURCES = new Set(["projects", "categories", "tags", "links", "settings"]);

/**
 * 判斷是否提供管理介面。
 *
 * **預設為關閉**：`wrangler.jsonc` 把 ADMIN_ENABLED 設為 "false"，
 * 因此任何部署出去的版本預設都沒有管理介面。本機開發則透過
 * `.dev.vars` 明確開啟（該檔案不會被部署，也不進版本控制）。
 *
 * 這個方向是刻意的——忘記設定時的結果應該是「功能少一點」，
 * 而不是「後台大門敞開」。
 *
 * @param {Env} env
 * @returns {boolean}
 */
function isAdminEnabled(env) {
  return env?.ADMIN_ENABLED === "true";
}

/**
 * 管理介面關閉時的統一回應。
 *
 * 回 404 而不是 403：不透露「這裡其實有後台，只是你沒權限」。
 *
 * @returns {Response}
 */
function adminDisabled() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

const HEALTH_BODY = JSON.stringify({ status: "ok" });

/**
 * @param {Request} request
 * @returns {Response}
 */
function healthResponse(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  return new Response(HEALTH_BODY, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/**
 * API 路由分派。
 *
 * 這些全部是管理用 API，正式環境由 `src/admin-gate.js` 的密碼閘道保護
 * （見階段二計畫第 4.3 節：只保護 /admin 會讓管理 API 裸露——這正是為什麼
 * 下面的登入檢查是獨立於 `/admin` 靜態路由的第二道檢查，不能只做一邊）。
 *
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {string[]} segments 已去除空片段的路徑，例如 ["api", "projects", "1"]
 * @returns {Promise<Response>}
 */
async function handleApi(request, env, url, segments) {
  const resource = segments[1];
  const isAdminResource = ADMIN_API_RESOURCES.has(resource);

  // 管理 API 在管理介面關閉時完全不存在。
  // 這個檢查必須在資料庫之前——沒開放就沒有理由碰資料庫。
  if (isAdminResource && !isAdminEnabled(env)) {
    return adminDisabled();
  }

  // 後台開著，但這次請求沒有通過登入——回 401（後台存在但你未登入），
  // 不是 404（後台整體關閉）：兩種狀態語意不同，回應也該不同。
  // API 呼叫收到的是 JSON 錯誤，不是登入頁的 HTML——呼叫端是程式，不是瀏覽器。
  if (isAdminResource && !(await isAdminAuthenticated(request, env))) {
    return jsonError(401, "ADMIN_AUTH_REQUIRED", "Sign in to the admin panel first.");
  }

  const database = requireDatabase(env);

  if (!database.db) {
    return database.response;
  }

  const rest = segments.slice(2);

  // Gallery 是唯一開放給未授權訪客的 API，且只有讀取。
  if (resource === "gallery") {
    return handleGallery(request, database.db, url, rest);
  }

  // /api/site 同樣開放給未授權訪客——`site-footer.js` 在每個頁面（含未登入的
  // 訪客看到的首頁）都要能拿到站名。只回站名一個欄位，見 routes/site.js 檔頭註解。
  if (resource === "site") {
    return handleSite(request, database.db, rest);
  }

  // 專案的子資源：/api/projects/:id/{thumbnail,policy,deployments,primary}
  if (resource === "projects" && rest.length === 2) {
    const projectId = Number(rest[0]);

    if (!Number.isInteger(projectId) || projectId < 1) {
      return jsonError(404, "PROJECT_NOT_FOUND", "Project not found.");
    }

    if (rest[1] === "thumbnail") {
      if (request.method !== "POST") {
        return methodNotAllowed(["POST"]);
      }

      return handleThumbnailUpload(request, database.db, env, projectId);
    }

    if (rest[1] === "policy") {
      return handlePolicy(request, database.db, projectId);
    }

    if (rest[1] === "deployments") {
      return handleDeployments(request, database.db, url, projectId);
    }

    if (rest[1] === "primary") {
      return handleSetPrimary(request, database.db, projectId);
    }

    return jsonError(404, "NOT_FOUND", "Resource not found.");
  }

  if (resource === "projects") {
    return handleProjects(request, database.db, url, rest);
  }

  if (resource === "categories" || resource === "tags") {
    return handleTaxonomy(request, database.db, resource, rest);
  }

  if (resource === "links") {
    return handleLinks(request, database.db, rest);
  }

  if (resource === "settings") {
    return handleSettings(request, database.db, rest);
  }

  return jsonError(404, "NOT_FOUND", "Resource not found.");
}

/**
 * The Hub owns metadata only. Access, project injection, and deployment
 * adapters belong to later Tasks. (Thumbnails moved into D1 on 2026-08-30;
 * the R2 bucket this comment used to mention was never enabled.)
 *
 * @type {ExportedHandler<Env>}
 */
const worker = {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康檢查不依賴資料庫，必須在 requireDatabase 之前處理。
    if (url.pathname === "/api/health") {
      return healthResponse(request);
    }

    // 管理後台頁面。關閉時連靜態檔案都不送出——只擋 API 是不夠的，
    // 後台頁面本身也會揭露結構與可用的操作。
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!isAdminEnabled(env)) {
        return adminDisabled();
      }

      // 登入／登出是唯二不需要先通過登入檢查就能到達的 /admin 路徑，
      // 必須在下面的驗證檢查之前先攔截，否則永遠進不了登入頁。
      if (url.pathname === ADMIN_LOGIN_PATH) {
        if (request.method === "GET") {
          return renderAdminLoginPage();
        }

        if (request.method !== "POST") {
          return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
        }

        return handleAdminLogin(request, env);
      }

      if (url.pathname === ADMIN_LOGOUT_PATH) {
        return handleAdminLogout();
      }

      if (!(await isAdminAuthenticated(request, env))) {
        // 網頁請求看到登入頁；子資源（admin.js／admin.css 等）一律 404，
        // 不洩漏後台內容存在與否——與每專案密碼閘道用同一條規則（wantsHtml）。
        return wantsHtml(request) ? renderAdminLoginPage() : adminDisabled();
      }

      return env.ASSETS.fetch(request);
    }

    // 展示圖片由 Worker 從 D1 讀出（2026-08-30 起；原本是 R2，但那個綁定
    // 從來沒啟用過，見 wrangler.jsonc）。位元組分段存放，讀取端負責接回來。
    if (url.pathname.startsWith("/media/thumbnails/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      return handleThumbnailFetch(request, env, segments.slice(2));
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      return handleApi(request, env, url, segments);
    }

    // Every other static route stays asset-first. /admin/ never reaches this
    // fallback — it returns above, gated by src/admin-gate.js.
    return env.ASSETS.fetch(request);
  },
};

export default worker;
