// @ts-check

/**
 * Hub API 的共用 HTTP 工具。
 *
 * 這一層只負責「請求進來、回應出去」的格式與防護，不含任何商業邏輯，
 * 也不直接接觸資料庫。所有 Response 形狀都必須經過這裡，確保 Error Envelope 一致。
 */

/**
 * @typedef {{ fetch(request: Request): Promise<Response> }} AssetBinding
 * @typedef {{ ASSETS: AssetBinding, DB?: D1Database }} Env
 */

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** API Body 上限。Hub Metadata 都是短文字，64 KiB 綽綽有餘。 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
function jsonResponse(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": JSON_CONTENT_TYPE,
      ...extraHeaders,
    },
  });
}

/**
 * 成功回應，固定包在 `data` 之下。
 *
 * @param {unknown} data
 * @param {number} [status]
 * @returns {Response}
 */
export function jsonData(data, status = 200) {
  return jsonResponse(status, { data });
}

/**
 * 失敗回應。永遠不包含 Stack Trace、SQL、Secret 或內部路徑。
 *
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [fields]
 * @returns {Response}
 */
export function jsonError(status, code, message, fields) {
  /** @type {{ code: string, message: string, fields?: Record<string, string> }} */
  const error = { code, message };

  if (fields && Object.keys(fields).length > 0) {
    error.fields = fields;
  }

  return jsonResponse(status, { error });
}

/**
 * @param {string[]} allowed
 * @returns {Response}
 */
export function methodNotAllowed(allowed) {
  const allow = allowed.join(", ");

  return new Response(JSON.stringify({
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: `Allowed methods: ${allow}.`,
    },
  }), {
    status: 405,
    headers: {
      Allow: allow,
      "Cache-Control": "no-store",
      "Content-Type": JSON_CONTENT_TYPE,
    },
  });
}

/**
 * 取得 D1 binding；未配置或型別不符時回 null。
 *
 * @param {Env} env
 * @returns {D1Database | null}
 */
export function getDatabase(env) {
  const db = env?.DB;

  if (!db || typeof db.prepare !== "function") {
    return null;
  }

  return db;
}

/**
 * 需要資料庫的路徑統一用這個包裝，缺 binding 時回傳可讀的 503，
 * 而不是拋出 `Cannot read properties of undefined`。
 *
 * @param {Env} env
 * @returns {{ db: D1Database, response?: undefined } | { db: null, response: Response }}
 */
export function requireDatabase(env) {
  const db = getDatabase(env);

  if (!db) {
    return {
      db: null,
      response: jsonError(
        503,
        "DATABASE_NOT_CONFIGURED",
        "Hub D1 binding is not configured for this environment.",
      ),
    };
  }

  return { db };
}

/**
 * 讀取並解析 JSON Body。
 *
 * @param {Request} request
 * @returns {Promise<{ value: Record<string, unknown>, response?: undefined } | { value: null, response: Response }>}
 */
export async function readJsonBody(request) {
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();

  if (!contentType.startsWith("application/json")) {
    return {
      value: null,
      response: jsonError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Request body must be application/json.",
      ),
    };
  }

  const raw = await request.text();

  // Workers 不保證 Content-Length 可信，因此以實際讀到的位元組長度為準。
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return {
      value: null,
      response: jsonError(413, "PAYLOAD_TOO_LARGE", "Request body is too large."),
    };
  }

  /** @type {unknown} */
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      value: null,
      response: jsonError(400, "INVALID_JSON", "Request body is not valid JSON."),
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      value: null,
      response: jsonError(400, "INVALID_JSON", "Request body must be a JSON object."),
    };
  }

  return { value: /** @type {Record<string, unknown>} */ (parsed) };
}

/**
 * 阻擋跨站的變更型請求（CSRF 防護的一層）。
 *
 * 判定原則：
 *   - `Sec-Fetch-Site` 明確表示 cross-site／same-site 時直接拒絕。
 *   - `Origin` 存在但與請求本身的 origin 不同時拒絕。
 *   - 兩個標頭都不存在時放行：這是非瀏覽器客戶端（本地測試、CLI）的情況，
 *     而管理 API 的主要保護層是 `src/admin-gate.js` 的登入檢查，不是這個檢查。
 *
 * @param {Request} request
 * @returns {Response | null} 拒絕時回傳 Response，通過時回傳 null
 */
export function rejectCrossSite(request) {
  const site = request.headers.get("Sec-Fetch-Site");

  if (site && site !== "same-origin" && site !== "none") {
    return jsonError(
      403,
      "CROSS_SITE_FORBIDDEN",
      "Cross-site requests are not allowed for this endpoint.",
    );
  }

  const origin = request.headers.get("Origin");

  if (origin) {
    let requestOrigin;

    try {
      requestOrigin = new URL(request.url).origin;
    } catch {
      requestOrigin = null;
    }

    if (origin !== requestOrigin) {
      return jsonError(
        403,
        "CROSS_SITE_FORBIDDEN",
        "Cross-site requests are not allowed for this endpoint.",
      );
    }
  }

  return null;
}

/**
 * 統一的未預期錯誤處理。呼叫端只記錄錯誤碼與動作，不外洩內部細節。
 *
 * @returns {Response}
 */
export function internalError() {
  return jsonError(500, "INTERNAL_ERROR", "Unexpected server error.");
}
