// @ts-check

import { internalError, jsonData, jsonError, methodNotAllowed, rejectCrossSite } from "../http.js";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  createObjectKey,
  detectImageType,
  isValidObjectKey,
} from "../images.js";
import { deleteThumbnail, getThumbnail, putThumbnail } from "../repositories/thumbnails.js";

/**
 * 超過大小上限時的錯誤訊息。
 *
 * 刻意不只說「檔案太大」——那對不懂技術的人沒有用。要告訴他**怎麼辦**，
 * 而且是他電腦上本來就有的工具做得到的事。
 */
const TOO_LARGE_HINT =
  "圖片不能超過 1 MB。縮圖只是卡片上的一小塊，不需要原始解析度——" +
  "用「小畫家」開啟圖片 →「重新調整大小」→ 改成 50%，通常就會降到 300 KB 以內。";

/**
 * 從 `thumbnail_url` 取出「由這個路由管理的」物件名稱。
 *
 * 回 null 的情況包含：使用者手動填的外部網址、舊制的靜態檔路徑
 * （`/thumbnails/xxx.png`，由 `hub ship` 搬進 public/）、以及形狀不合法的值。
 * 那些都不是這裡存的東西，不該去刪。
 *
 * @param {unknown} thumbnailUrl
 * @returns {string | null}
 */
export function parseOwnThumbnailKey(thumbnailUrl) {
  if (typeof thumbnailUrl !== "string") {
    return null;
  }

  const prefix = "/media/thumbnails/";

  if (!thumbnailUrl.startsWith(prefix)) {
    return null;
  }

  const key = thumbnailUrl.slice(prefix.length);

  return isValidObjectKey(key) ? key : null;
}

/**
 * 上傳專案展示圖片。
 *
 * 這是管理用 API，正式環境由 `src/admin-gate.js` 的密碼閘道保護。
 *
 * 2026-08-30 起存進 D1（方案 B），不再需要 R2。這個按鈕在那之前一直回 503，
 * 因為 R2 即使免費額度也要綁信用卡，那個綁定從來沒有啟用過——也就是說
 * **不使用 CLI 的人一直沒有辦法設縮圖**。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {unknown} _env 保留參數位置，D1 由 db 傳入，不再需要 env
 * @param {number} projectId
 * @returns {Promise<Response>}
 */
export async function handleThumbnailUpload(request, db, _env, projectId) {
  const rejected = rejectCrossSite(request);

  if (rejected) {
    return rejected;
  }

  try {
    const project = await db
      .prepare("SELECT id, thumbnail_url FROM projects WHERE id = ?")
      .bind(projectId)
      .first();

    if (!project) {
      return jsonError(404, "PROJECT_NOT_FOUND", "Project not found.");
    }

    const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();

    if (!contentType.startsWith("multipart/form-data")) {
      return jsonError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload must be multipart/form-data.");
    }

    const form = await request.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      return jsonError(400, "VALIDATION_FAILED", "Missing file field.", {
        file: "請選擇一個圖片檔案。",
      });
    }

    // 先看宣告的大小，避免把過大的檔案整個讀進記憶體。
    if (typeof file.size === "number" && file.size > MAX_IMAGE_BYTES) {
      return jsonError(413, "PAYLOAD_TOO_LARGE", "Image exceeds the 1 MiB limit.", {
        file: TOO_LARGE_HINT,
      });
    }

    const buffer = await file.arrayBuffer();

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return jsonError(413, "PAYLOAD_TOO_LARGE", "Image exceeds the 1 MiB limit.", {
        file: TOO_LARGE_HINT,
      });
    }

    const bytes = new Uint8Array(buffer);

    // 只認檔案本身的位元組特徵。副檔名與瀏覽器宣告的類型都不採信。
    const detected = detectImageType(bytes);

    if (!detected || !ALLOWED_IMAGE_TYPES.includes(detected)) {
      return jsonError(415, "UNSUPPORTED_IMAGE_TYPE", "Only PNG, JPEG, WebP and AVIF are accepted.", {
        file: "只接受 PNG、JPEG、WebP、AVIF 格式的圖片。",
      });
    }

    const key = createObjectKey(detected);
    const now = new Date().toISOString();

    await putThumbnail(db, { objectKey: key, contentType: detected, bytes, now });

    const thumbnailUrl = `/media/thumbnails/${key}`;

    await db
      .prepare("UPDATE projects SET thumbnail_url = ?, updated_at = ? WHERE id = ?")
      .bind(thumbnailUrl, now, projectId)
      .run();

    /*
     * 換圖時把舊的位元組刪掉。
     *
     * 每次上傳都產生新的 UUID，所以舊圖不會被覆蓋，而是留在資料庫裡沒有人
     * 指向它——換十次圖就有九份孤兒資料，而 D1 免費方案的單一資料庫上限是
     * 500 MB。這件事在前端完全看不出來，只會慢慢吃掉配額。
     *
     * 刻意排在專案更新**之後**：先確保新圖已經被指到，再刪舊的。順序反過來
     * 的話，中間失敗會讓專案指向一張已經被刪掉的圖。
     *
     * 只刪自己管的路徑：thumbnail_url 也可能是使用者手動填的外部網址，
     * 或是舊制的 /thumbnails/xxx.png 靜態檔，那些都不該碰。
     */
    const previousKey = parseOwnThumbnailKey(project.thumbnail_url);

    if (previousKey !== null && previousKey !== key) {
      try {
        await deleteThumbnail(db, previousKey);
      } catch {
        // 刪不掉只是留下一份孤兒資料，不該讓已經成功的上傳變成失敗。
      }
    }

    console.log(JSON.stringify({
      action: "thumbnail.upload",
      project_id: projectId,
      status: 201,
      code: null,
    }));

    return jsonData({ thumbnail_url: thumbnailUrl, content_type: detected }, 201);
  } catch (error) {
    console.log(JSON.stringify({
      action: "thumbnail.internal_error",
      project_id: projectId,
      status: 500,
      code: "INTERNAL_ERROR",
    }));

    return internalError();
  }
}

/**
 * 讀取展示圖片。這是公開路徑：圖片本身不含機密，且展示中心需要它。
 *
 * 2026-08-30 起改從 D1 讀（方案 B）。原本讀 R2，但 R2 即使免費額度也要
 * 綁信用卡，使用者已實測並否決；D1 本來就在用，不需要另外綁卡。
 * 分段的理由見 migration 0004。
 *
 * @param {Request} request
 * @param {{ DB?: D1Database }} env
 * @param {string[]} segments `/media/thumbnails` 之後的路徑片段
 * @returns {Promise<Response>}
 */
export async function handleThumbnailFetch(request, env, segments) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(["GET", "HEAD"]);
  }

  if (segments.length !== 1) {
    return new Response("Not found", { status: 404 });
  }

  const key = segments[0];

  // 只接受既定形狀的物件名稱，避免任何路徑穿越或探測行為。
  if (!isValidObjectKey(key)) {
    return new Response("Not found", { status: 404 });
  }

  const db = env?.DB;

  if (!db || typeof db.prepare !== "function") {
    return new Response("Thumbnail storage is not configured", { status: 503 });
  }

  try {
    const stored = await getThumbnail(db, key);

    if (stored === null) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", stored.contentType);
    /*
     * 永久快取是安全的：物件名稱是 UUID，內容一旦寫入就不會變——換圖會產生
     * 新的 key。這一條同時把 D1 的讀取量壓到極低，多數請求根本不會進到
     * Worker，更不會查資料庫。
     */
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("ETag", `"${key}"`);
    headers.set("Content-Length", String(stored.bytes.length));
    // 圖片一律當附件之外的資源處理，並禁止瀏覽器猜測類型。
    headers.set("X-Content-Type-Options", "nosniff");

    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }

    return new Response(stored.bytes, { headers });
  } catch (error) {
    return new Response("Unable to read object", { status: 500 });
  }
}
