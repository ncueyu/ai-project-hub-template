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
  createProject,
  deleteProject,
  getProjectById,
  listProjects,
  setPrimaryProject,
  slugExists,
  updateProject,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../repositories/projects.js";
import { categoryExists, findMissingTagIds } from "../repositories/taxonomy.js";
import { validateProjectCreate, validateProjectPatch } from "../validation.js";
import { VISIBILITIES } from "../validation.js";

const MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE"]);

/**
 * 只記錄結構化的操作結果，不記錄 payload 內容、SQL 或任何密碼相關資料。
 *
 * @param {string} action
 * @param {{ projectId?: number | null, status: number, code?: string }} detail
 */
function logAction(action, detail) {
  console.log(JSON.stringify({
    action,
    project_id: detail.projectId ?? null,
    status: detail.status,
    code: detail.code ?? null,
  }));
}

/**
 * @param {URL} url
 * @returns {{ ok: true, value: { limit: number, offset: number, visibility: string | null, categoryId: number | null, q: string | null } } | { ok: false, response: Response }}
 */
function parseListQuery(url) {
  /** @type {Record<string, string>} */
  const fields = {};

  let limit = DEFAULT_LIMIT;
  const rawLimit = url.searchParams.get("limit");

  if (rawLimit !== null) {
    const parsed = Number(rawLimit);

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      fields.limit = `必須是 1 到 ${MAX_LIMIT} 之間的整數。`;
    } else {
      limit = parsed;
    }
  }

  let offset = 0;
  const rawOffset = url.searchParams.get("offset");

  if (rawOffset !== null) {
    const parsed = Number(rawOffset);

    if (!Number.isInteger(parsed) || parsed < 0) {
      fields.offset = "必須是 0 或正整數。";
    } else {
      offset = parsed;
    }
  }

  const visibility = url.searchParams.get("visibility");

  if (visibility !== null && !VISIBILITIES.includes(visibility)) {
    fields.visibility = `只能是下列其中之一：${VISIBILITIES.join("、")}。`;
  }

  let categoryId = null;
  const rawCategoryId = url.searchParams.get("category_id");

  if (rawCategoryId !== null) {
    const parsed = Number(rawCategoryId);

    if (!Number.isInteger(parsed) || parsed < 1) {
      fields.category_id = "必須是正整數。";
    } else {
      categoryId = parsed;
    }
  }

  if (Object.keys(fields).length > 0) {
    return {
      ok: false,
      response: jsonError(400, "VALIDATION_FAILED", "Query parameters are invalid.", fields),
    };
  }

  return {
    ok: true,
    value: { limit, offset, visibility, categoryId, q: url.searchParams.get("q") },
  };
}

/**
 * 檢查 category_id 與 tag_ids 的參照完整性。
 *
 * @param {D1Database} db
 * @param {Record<string, any>} value
 * @returns {Promise<Record<string, string> | null>}
 */
async function checkReferences(db, value) {
  /** @type {Record<string, string>} */
  const fields = {};

  if (value.category_id !== null && value.category_id !== undefined) {
    if (!(await categoryExists(db, value.category_id))) {
      fields.category_id = "指定的分類不存在。";
    }
  }

  if (Array.isArray(value.tag_ids) && value.tag_ids.length > 0) {
    const missing = await findMissingTagIds(db, value.tag_ids);

    if (missing.length > 0) {
      fields.tag_ids = `下列標籤不存在：${missing.join(", ")}。`;
    }
  }

  return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * 管理用 Projects API。這是 Admin API，正式環境由 `src/admin-gate.js` 的密碼閘道保護。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {URL} url
 * @param {string[]} segments `/api/projects` 之後的路徑片段
 * @returns {Promise<Response>}
 */
export async function handleProjects(request, db, url, segments) {
  if (MUTATING_METHODS.has(request.method)) {
    const rejected = rejectCrossSite(request);

    if (rejected) {
      logAction("projects.blocked_cross_site", { status: 403, code: "CROSS_SITE_FORBIDDEN" });
      return rejected;
    }
  }

  try {
    if (segments.length === 0) {
      if (request.method === "GET" || request.method === "HEAD") {
        return await handleList(db, url);
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
      return jsonError(404, "PROJECT_NOT_FOUND", "Project not found.");
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
    logAction("projects.internal_error", { status: 500, code: "INTERNAL_ERROR" });
    return internalError();
  }
}

/**
 * @param {D1Database} db
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleList(db, url) {
  const parsed = parseListQuery(url);

  if (!parsed.ok) {
    return parsed.response;
  }

  const { items, total } = await listProjects(db, parsed.value);

  return jsonData({
    items,
    pagination: {
      limit: parsed.value.limit,
      offset: parsed.value.offset,
      total,
    },
  });
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

  const validated = validateProjectCreate(body.value);

  if (!validated.ok) {
    return jsonError(400, "VALIDATION_FAILED", "Project payload is invalid.", validated.fields);
  }

  if (await slugExists(db, /** @type {string} */ (validated.value.slug))) {
    return jsonError(409, "SLUG_CONFLICT", "Another project already uses this slug.", {
      slug: "已經有其他專案使用這個代稱。",
    });
  }

  const referenceErrors = await checkReferences(db, validated.value);

  if (referenceErrors) {
    return jsonError(400, "VALIDATION_FAILED", "Referenced records do not exist.", referenceErrors);
  }

  const created = await createProject(db, validated.value, new Date().toISOString());

  if (!created) {
    return internalError();
  }

  logAction("projects.create", { projectId: Number(created.id), status: 201 });

  return jsonData(created, 201);
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<Response>}
 */
async function handleGet(db, id) {
  const project = await getProjectById(db, id);

  if (!project) {
    return jsonError(404, "PROJECT_NOT_FOUND", "Project not found.");
  }

  return jsonData(project);
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

  const existing = await getProjectById(db, id);

  if (!existing) {
    return jsonError(404, "PROJECT_NOT_FOUND", "Project not found.");
  }

  const validated = validateProjectPatch(body.value);

  if (!validated.ok) {
    return jsonError(400, "VALIDATION_FAILED", "Project payload is invalid.", validated.fields);
  }

  if (
    typeof validated.value.slug === "string"
    && await slugExists(db, validated.value.slug, id)
  ) {
    return jsonError(409, "SLUG_CONFLICT", "Another project already uses this slug.", {
      slug: "已經有其他專案使用這個代稱。",
    });
  }

  const referenceErrors = await checkReferences(db, validated.value);

  if (referenceErrors) {
    return jsonError(400, "VALIDATION_FAILED", "Referenced records do not exist.", referenceErrors);
  }

  const updated = await updateProject(db, id, validated.value, new Date().toISOString());

  if (!updated) {
    return internalError();
  }

  logAction("projects.update", { projectId: id, status: 200 });

  return jsonData(updated);
}

/**
 * 只刪除 Hub D1 的 Metadata，不呼叫任何外部平台 API。
 *
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<Response>}
 */
async function handleDelete(db, id) {
  const removed = await deleteProject(db, id);

  if (!removed) {
    return jsonError(404, "PROJECT_NOT_FOUND", "Project not found.");
  }

  logAction("projects.delete", { projectId: id, status: 204 });

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * 「設為主卡片」子資源：`PUT /api/projects/:id/primary`。
 *
 * 不需要 request body——這是一個純粹依路徑決定的動作，不是欄位更新，
 * 因此刻意不走 `handlePatch`／`UPDATABLE_COLUMNS` 那條路：`sort_order`
 * 的重新編號牽動其他多筆專案，不是「改一個欄位」語意，混進去會讓
 * PATCH 的白名單機制多一個特例。用 PUT 而非 POST，理由與
 * `routes/policies.js` 的密碼設定端點一致——重複呼叫是自然的不動點
 * （fixed point），語意上是「讓它是這個狀態」而不是「疊加一次動作」。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {number} projectId
 * @returns {Promise<Response>}
 */
export async function handleSetPrimary(request, db, projectId) {
  if (request.method !== "PUT") {
    return methodNotAllowed(["PUT"]);
  }

  const rejected = rejectCrossSite(request);

  if (rejected) {
    logAction("projects.blocked_cross_site", { status: 403, code: "CROSS_SITE_FORBIDDEN" });
    return rejected;
  }

  try {
    const updated = await setPrimaryProject(db, projectId, new Date().toISOString());

    if (!updated) {
      return jsonError(404, "PROJECT_NOT_FOUND", "Project not found.");
    }

    logAction("projects.set_primary", { projectId, status: 200 });

    return jsonData(updated);
  } catch (error) {
    logAction("projects.internal_error", { projectId, status: 500, code: "INTERNAL_ERROR" });
    return internalError();
  }
}
