// @ts-check

import { internalError, jsonData, jsonError, methodNotAllowed, rejectCrossSite } from "../http.js";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  createObjectKey,
  detectImageType,
  isValidObjectKey,
} from "../images.js";

/**
 * 取得 R2 binding。未配置時回 null，由呼叫端轉成明確的 503。
 *
 * @param {{ THUMBNAILS?: R2Bucket }} env
 * @returns {R2Bucket | null}
 */
export function getThumbnailBucket(env) {
  const bucket = env?.THUMBNAILS;

  if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function") {
    return null;
  }

  return bucket;
}

function bucketNotConfigured() {
  return jsonError(
    503,
    "R2_NOT_CONFIGURED",
    "Thumbnail storage is not configured. You can still set a thumbnail URL manually.",
  );
}

/**
 * 上傳專案展示圖片。
 *
 * 這是管理用 API，正式環境由 `src/admin-gate.js` 的密碼閘道保護。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {{ THUMBNAILS?: R2Bucket }} env
 * @param {number} projectId
 * @returns {Promise<Response>}
 */
export async function handleThumbnailUpload(request, db, env, projectId) {
  const rejected = rejectCrossSite(request);

  if (rejected) {
    return rejected;
  }

  const bucket = getThumbnailBucket(env);

  if (!bucket) {
    return bucketNotConfigured();
  }

  try {
    const project = await db
      .prepare("SELECT id FROM projects WHERE id = ?")
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
      return jsonError(413, "PAYLOAD_TOO_LARGE", "Image exceeds the 5 MiB limit.", {
        file: "圖片不能超過 5 MiB。",
      });
    }

    const buffer = await file.arrayBuffer();

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return jsonError(413, "PAYLOAD_TOO_LARGE", "Image exceeds the 5 MiB limit.", {
        file: "圖片不能超過 5 MiB。",
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

    await bucket.put(key, bytes, {
      httpMetadata: {
        contentType: detected,
        // 物件名稱是隨機且唯一的，內容不會變動，因此可以長時間快取。
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    // 對外一律走 Hub 自己的媒體路由，不使用 r2.dev（見計畫第 4.4 節）。
    const thumbnailUrl = `/media/thumbnails/${key}`;
    const now = new Date().toISOString();

    await db
      .prepare("UPDATE projects SET thumbnail_url = ?, updated_at = ? WHERE id = ?")
      .bind(thumbnailUrl, now, projectId)
      .run();

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
 * @param {Request} request
 * @param {{ THUMBNAILS?: R2Bucket }} env
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

  const bucket = getThumbnailBucket(env);

  if (!bucket) {
    return new Response("Thumbnail storage is not configured", { status: 503 });
  }

  try {
    const object = await bucket.get(key);

    if (!object) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
    headers.set("Cache-Control", object.httpMetadata?.cacheControl ?? "public, max-age=31536000, immutable");
    headers.set("ETag", object.httpEtag);
    // 圖片一律當附件之外的資源處理，並禁止瀏覽器猜測類型。
    headers.set("X-Content-Type-Options", "nosniff");

    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }

    return new Response(object.body, { headers });
  } catch (error) {
    return new Response("Unable to read object", { status: 500 });
  }
}
