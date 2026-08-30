// @ts-check

import { internalError, jsonData, jsonError, methodNotAllowed } from "../http.js";
import { getSiteName, getSiteLogo, getSiteTheme } from "../repositories/settings.js";

/**
 * 公開設定的白名單——這個端點唯一能回的欄位集合。
 *
 * 這是「這裡刻意只回這些欄位」的明確宣告，不是靠程式碼順手拼出來的物件
 * 形狀。**新增可公開設定時，必須同時更新這份清單與
 * `test/settings.test.mjs` 裡「回傳的鍵集合完全等於白名單」那個測試**——
 * 兩邊都要手動改，才能在漏改任何一邊時被測試擋下來（見該測試的註解）。
 */
export const PUBLIC_SETTINGS_KEYS = Object.freeze(["site_name", "site_logo", "site_theme"]);

/**
 * 公開站台設定端點：`/api/site`。
 *
 * 這是唯一給未授權訪客的站名／品牌圖示來源——`public/site-footer.js` 在
 * 每個頁面載入時呼叫它，把 `brand-subtitle`／`aria-label`／
 * `document.title`／`.brand-mark` 從中性預設值換成管理者在後台設定的值
 * （站名見 2026-08-27-工作計畫-站名與hub-init.md 第三節 Part A-2；
 * 品牌圖示 `site_logo` 2026-08-28 新增，見
 * 2026-08-27-工作計畫-主畫面改造.md Part A）。
 *
 * 刻意只回 `PUBLIC_SETTINGS_KEYS` 白名單內的欄位，不回整個 `site_settings`
 * 表：這是公開端點，不能成為其他設定（例如未來可能加入的鍵）的洩漏出口。
 * 要讀寫其他設定，走受管理驗證保護的 `/api/settings/*`。
 *
 * `getSiteName`／`getSiteLogo` 讀不到列、或存到非法值時本身就會回預設值，
 * 不拋錯；這裡仍包一層 try/catch，理由與 `handleGallery` 系列相同——D1
 * 連線本身若不可用，`.prepare()/.first()` 會直接拋例外，這裡要把例外訊息
 * 寫進伺服器日誌，而不是讓未捕捉的例外洩漏堆疊或造成不一致的回應。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {string[]} segments `/api/site` 之後的路徑片段——這個端點不接受子路徑
 * @returns {Promise<Response>}
 */
export async function handleSite(request, db, segments) {
  if (segments.length !== 0) {
    return jsonError(404, "NOT_FOUND", "Resource not found.");
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(["GET", "HEAD"]);
  }

  try {
    const [site_name, site_logo, site_theme] = await Promise.all([
      getSiteName(db),
      getSiteLogo(db),
      getSiteTheme(db),
    ]);

    return jsonData({ site_name, site_logo, site_theme });
  } catch (error) {
    console.log(JSON.stringify({
      action: "site.internal_error",
      status: 500,
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }));
    return internalError();
  }
}
