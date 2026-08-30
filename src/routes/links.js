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
  createLink,
  deleteLink,
  getLinkById,
  listLinks,
  updateLink,
} from "../repositories/links.js";
import { categoryExists } from "../repositories/taxonomy.js";
import { validateLinkCreate, validateLinkPatch } from "../validation.js";

const MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE"]);

/**
 * 只記錄結構化的操作結果，不記錄 payload 內容或任何使用者輸入
 * （與 `routes/projects.js`、`routes/taxonomy.js` 同慣例）。
 *
 * @param {string} action
 * @param {{ linkId?: number | null, status: number, code?: string }} detail
 */
function logAction(action, detail) {
  console.log(JSON.stringify({
    action,
    link_id: detail.linkId ?? null,
    status: detail.status,
    code: detail.code ?? null,
  }));
}

/**
 * 檢查 category_id 的參照完整性。與 `routes/projects.js` 的 `checkReferences`
 * 同一套邏輯，links 沒有 tag_ids，只剩這一項需要檢查。
 *
 * @param {D1Database} db
 * @param {Record<string, any>} value
 * @returns {Promise<Record<string, string> | null>}
 */
async function checkReferences(db, value) {
  if (value.category_id === null || value.category_id === undefined) {
    return null;
  }

  if (await categoryExists(db, value.category_id)) {
    return null;
  }

  return { category_id: "指定的分類不存在。" };
}

/**
 * 管理用推薦連結 API。這是 Admin API，正式環境由 `src/admin-gate.js` 的密碼閘道保護
 * （見 `src/index.js` 的 `ADMIN_API_RESOURCES`）。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {string[]} segments `/api/links` 之後的路徑片段
 * @returns {Promise<Response>}
 */
export async function handleLinks(request, db, segments) {
  if (MUTATING_METHODS.has(request.method)) {
    const rejected = rejectCrossSite(request);

    if (rejected) {
      logAction("links.blocked_cross_site", { status: 403, code: "CROSS_SITE_FORBIDDEN" });
      return rejected;
    }
  }

  try {
    if (segments.length === 0) {
      if (request.method === "GET" || request.method === "HEAD") {
        return jsonData({ items: await listLinks(db) });
      }

      if (request.method === "POST") {
        return await handleCreate(request, db);
      }

      return methodNotAllowed(["GET", "HEAD", "POST"]);
    }

    if (segments.length > 1) {
      return jsonError(404, "NOT_FOUND", "Resource not found.");
    }

    const id = Number(segments[0]);

    if (!Number.isInteger(id) || id < 1) {
      return jsonError(404, "LINK_NOT_FOUND", "Link not found.");
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return await handleGet(db, id);
    }

    if (request.method === "PATCH") {
      return await handlePatch(request, db, id);
    }

    if (request.method === "DELETE") {
      return await handleDelete(db, id);
    }

    return methodNotAllowed(["GET", "HEAD", "PATCH", "DELETE"]);
  } catch (error) {
    logAction("links.internal_error", { status: 500, code: "INTERNAL_ERROR" });
    return internalError();
  }
}

/**
 * @param {Request} request
 * @param {D1Database} db
 * @returns {Promise<Response>}
 */
async function handleCreate(request, db) {
  const body = await readJsonBody(request);

  if (body.response) {
    return body.response;
  }

  const validated = validateLinkCreate(body.value);

  if (!validated.ok) {
    return jsonError(400, "VALIDATION_FAILED", "Link payload is invalid.", validated.fields);
  }

  const referenceErrors = await checkReferences(db, validated.value);

  if (referenceErrors) {
    return jsonError(400, "VALIDATION_FAILED", "Referenced records do not exist.", referenceErrors);
  }

  const created = await createLink(db, validated.value, new Date().toISOString());

  if (!created) {
    return internalError();
  }

  logAction("links.create", { linkId: Number(created.id), status: 201 });

  return jsonData(created, 201);
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<Response>}
 */
async function handleGet(db, id) {
  const link = await getLinkById(db, id);

  if (!link) {
    return jsonError(404, "LINK_NOT_FOUND", "Link not found.");
  }

  return jsonData(link);
}

/**
 * @param {Request} request
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<Response>}
 */
async function handlePatch(request, db, id) {
  const body = await readJsonBody(request);

  if (body.response) {
    return body.response;
  }

  const existing = await getLinkById(db, id);

  if (!existing) {
    return jsonError(404, "LINK_NOT_FOUND", "Link not found.");
  }

  const validated = validateLinkPatch(body.value);

  if (!validated.ok) {
    return jsonError(400, "VALIDATION_FAILED", "Link payload is invalid.", validated.fields);
  }

  const referenceErrors = await checkReferences(db, validated.value);

  if (referenceErrors) {
    return jsonError(400, "VALIDATION_FAILED", "Referenced records do not exist.", referenceErrors);
  }

  const updated = await updateLink(db, id, validated.value, new Date().toISOString());

  if (!updated) {
    return internalError();
  }

  logAction("links.update", { linkId: id, status: 200 });

  return jsonData(updated);
}

/**
 * 只刪除連結本身，不影響分類（`category_id` 是 `ON DELETE SET NULL`，
 * 方向相反：這裡刪除的是連結，不會連帶影響分類）。
 *
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<Response>}
 */
async function handleDelete(db, id) {
  const removed = await deleteLink(db, id);

  if (!removed) {
    return jsonError(404, "LINK_NOT_FOUND", "Link not found.");
  }

  logAction("links.delete", { linkId: id, status: 204 });

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
