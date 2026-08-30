// @ts-check

import { internalError, jsonData, jsonError, methodNotAllowed } from "../http.js";
import { countUnlistedProjects, listPublicFilters, listPublicProjects } from "../repositories/gallery.js";
import { listPublicLinks } from "../repositories/links.js";
import { getGalleryLayout } from "../repositories/settings.js";

/**
 * 公開展示中心 API。
 *
 * 這是唯一可以給未授權訪客使用的 API，因此：
 *   - 只有讀取，沒有任何變更操作。
 *   - 只回傳 public 專案／`is_listed=1` 連結與可公開欄位。
 *   - 不接受任何能改變 visibility 過濾條件的參數。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {URL} url
 * @param {string[]} segments `/api/gallery` 之後的路徑片段
 * @returns {Promise<Response>}
 */
export async function handleGallery(request, db, url, segments) {
  if (segments.length !== 1 || (segments[0] !== "projects" && segments[0] !== "links")) {
    return jsonError(404, "NOT_FOUND", "Resource not found.");
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(["GET", "HEAD"]);
  }

  if (segments[0] === "links") {
    return handleGalleryLinks(db);
  }

  return handleGalleryProjects(request, db, url);
}

/**
 * `/api/gallery/projects`。
 *
 * `gallery_layout` 夾帶在這個既有回應裡，不另開端點——2026-08-27 工作計畫
 * 第 2-3 節 (1) 的選擇：展示中心本來就要等這個 fetch 才渲染卡片，版面設定
 * 跟資料同時到達，卡片區不會先以錯的版面畫一次再切換而閃動。
 * `test/api-contract.test.mjs`／`test/gallery.test.mjs` 都沒有對這個回應的
 * 頂層鍵集合做精確斷言（只對 `items` 裡單筆專案的鍵集合做精確斷言），
 * 所以加這個欄位不構成偷改契約測試。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleGalleryProjects(request, db, url) {
  try {
    const category = url.searchParams.get("category");
    const tag = url.searchParams.get("tag");

    const [items, filters, galleryLayout] = await Promise.all([
      listPublicProjects(db, { category, tag }),
      listPublicFilters(db),
      getGalleryLayout(db),
    ]);

    /*
     * `unlisted_count` 只在「一個可列出的專案都沒有」時才輸出。
     *
     * 用途是讓空狀態畫面分辨兩種完全不同的情況：真的還沒有任何專案，
     * 還是已經有專案但都沒公開（部署後預設 private，見
     * `countUnlistedProjects()` 的註解）。兩種情況該對使用者說的話不一樣，
     * 說錯會讓他以為自己做錯了。
     *
     * 有東西可看的時候不輸出：這是公開 API，那個數字對訪客沒有用途，
     * 少給一點就少揭露一點。所以這個欄位是**條件性**的，前端必須容許它不存在。
     */
    const unlistedCount = items.length === 0 ? await countUnlistedProjects(db) : 0;

    return jsonData({
      items,
      filters,
      applied: { category, tag },
      gallery_layout: galleryLayout,
      ...(unlistedCount > 0 ? { unlisted_count: unlistedCount } : {}),
    });
  } catch (error) {
    // 只把錯誤訊息寫進伺服器日誌，回應給瀏覽器的仍然是不透露內情的 internalError()。
    // 少了這一行，線上出事時日誌只寫「有錯」不寫「錯什麼」——2026-08-24 就因此
    // 多花了一輪才定位到 D1 的錯誤，而使用者看到的還是誤導人的「無法連線到伺服器」。
    console.log(JSON.stringify({
      action: "gallery.internal_error",
      status: 500,
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }));
    return internalError();
  }
}

/**
 * `/api/gallery/links`。獨立端點，不夾帶在 projects 回應裡——連結是分區
 * 呈現、與專案無關，硬塞進同一個回應會讓那個端點同時負責兩種實體
 * （2026-08-27 工作計畫第 2-3 節 (2)）。
 *
 * @param {D1Database} db
 * @returns {Promise<Response>}
 */
async function handleGalleryLinks(db) {
  try {
    const items = await listPublicLinks(db);

    return jsonData({ items });
  } catch (error) {
    console.log(JSON.stringify({
      action: "gallery.links.internal_error",
      status: 500,
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }));
    return internalError();
  }
}
