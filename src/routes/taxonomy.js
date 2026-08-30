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
  createTaxonomy,
  deleteTaxonomy,
  getTaxonomyById,
  listTaxonomy,
  taxonomyNameExists,
  taxonomySlugExists,
  updateTaxonomy,
} from "../repositories/taxonomy.js";
import { validateTaxonomy } from "../validation.js";

/** @typedef {"categories" | "tags"} TaxonomyKind */

const MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE"]);

const OPTIONS = Object.freeze({
  categories: { withDescription: true, withSortOrder: true, notFoundCode: "CATEGORY_NOT_FOUND" },
  tags: { withDescription: false, withSortOrder: false, notFoundCode: "TAG_NOT_FOUND" },
});

/**
 * 產生一個不重複的代稱。
 *
 * 使用者只輸入中文名稱時會走到這裡。中文不能直接當作網址代稱
 * （代稱只允許小寫英文、數字與連字號），因此改用簡短的隨機碼。
 * 代稱本身不需要有意義——它只是網址上的識別字。
 *
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @returns {Promise<string>}
 */
async function generateUniqueSlug(db, kind) {
  const prefix = kind === "categories" ? "c" : "t";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

    if (!(await taxonomySlugExists(db, kind, candidate))) {
      return candidate;
    }
  }

  // 連續五次都撞到的機率極低；真的發生就用完整的隨機值，確保不會失敗。
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * @param {string} action
 * @param {{ status: number, code?: string }} detail
 */
function logAction(action, detail) {
  console.log(JSON.stringify({
    action,
    status: detail.status,
    code: detail.code ?? null,
  }));
}

/**
 * Categories 與 Tags 的管理 API。兩者路由形狀相同，只有欄位與錯誤碼不同。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {string[]} segments
 * @returns {Promise<Response>}
 */
export async function handleTaxonomy(request, db, kind, segments) {
  if (MUTATING_METHODS.has(request.method)) {
    const rejected = rejectCrossSite(request);

    if (rejected) {
      logAction(`${kind}.blocked_cross_site`, { status: 403, code: "CROSS_SITE_FORBIDDEN" });
      return rejected;
    }
  }

  const options = OPTIONS[kind];

  try {
    if (segments.length === 0) {
      if (request.method === "GET" || request.method === "HEAD") {
        return jsonData({ items: await listTaxonomy(db, kind) });
      }

      if (request.method === "POST") {
        return await handleCreate(request, db, kind);
      }

      return methodNotAllowed(["GET", "HEAD", "POST"]);
    }

    if (segments.length > 1) {
      return jsonError(404, "NOT_FOUND", "Resource not found.");
    }

    const id = Number(segments[0]);

    if (!Number.isInteger(id) || id < 1) {
      return jsonError(404, options.notFoundCode, "Record not found.");
    }

    if (request.method === "PATCH") {
      return await handlePatch(request, db, kind, id);
    }

    if (request.method === "DELETE") {
      return await handleDelete(db, kind, id);
    }

    return methodNotAllowed(["PATCH", "DELETE"]);
  } catch (error) {
    logAction(`${kind}.internal_error`, { status: 500, code: "INTERNAL_ERROR" });
    return internalError();
  }
}

/**
 * @param {Request} request
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @returns {Promise<Response>}
 */
async function handleCreate(request, db, kind) {
  const options = OPTIONS[kind];
  const body = await readJsonBody(request);

  if (body.response) {
    return body.response;
  }

  const validated = validateTaxonomy(body.value, {
    withDescription: options.withDescription,
    withSortOrder: options.withSortOrder,
    partial: false,
  });

  if (!validated.ok) {
    return jsonError(400, "VALIDATION_FAILED", "Payload is invalid.", validated.fields);
  }

  if (await taxonomyNameExists(db, kind, /** @type {string} */ (validated.value.name))) {
    return jsonError(409, "NAME_CONFLICT", "Another record already uses this name.", {
      name: kind === "categories"
        ? "已經有同名的分類了。請從清單中選用既有的分類，或改一個不同的名稱。"
        : "已經有同名的標籤了。請改用既有的標籤，或改一個不同的名稱。",
    });
  }

  if (validated.value.slug) {
    if (await taxonomySlugExists(db, kind, /** @type {string} */ (validated.value.slug))) {
      return jsonError(409, "SLUG_CONFLICT", "Another record already uses this slug.", {
        slug: "已經有其他項目使用這個代稱。",
      });
    }
  } else {
    // 使用者沒填代稱時自動產生一個。代稱只用於網址，內容本身不重要，
    // 重要的是唯一且符合網址規則。
    validated.value.slug = await generateUniqueSlug(db, kind);
  }

  const created = await createTaxonomy(db, kind, validated.value, new Date().toISOString());

  if (!created) {
    return internalError();
  }

  logAction(`${kind}.create`, { status: 201 });

  return jsonData(created, 201);
}

/**
 * @param {Request} request
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {number} id
 * @returns {Promise<Response>}
 */
async function handlePatch(request, db, kind, id) {
  const options = OPTIONS[kind];
  const body = await readJsonBody(request);

  if (body.response) {
    return body.response;
  }

  const existing = await getTaxonomyById(db, kind, id);

  if (!existing) {
    return jsonError(404, options.notFoundCode, "Record not found.");
  }

  const validated = validateTaxonomy(body.value, {
    withDescription: options.withDescription,
    withSortOrder: options.withSortOrder,
    partial: true,
  });

  if (!validated.ok) {
    return jsonError(400, "VALIDATION_FAILED", "Payload is invalid.", validated.fields);
  }

  if (
    typeof validated.value.name === "string"
    && await taxonomyNameExists(db, kind, validated.value.name, id)
  ) {
    return jsonError(409, "NAME_CONFLICT", "Another record already uses this name.", {
      name: kind === "categories"
        ? "已經有同名的分類了。請改一個不同的名稱。"
        : "已經有同名的標籤了。請改一個不同的名稱。",
    });
  }

  if (
    typeof validated.value.slug === "string"
    && await taxonomySlugExists(db, kind, validated.value.slug, id)
  ) {
    return jsonError(409, "SLUG_CONFLICT", "Another record already uses this slug.", {
      slug: "已經有其他項目使用這個代稱。",
    });
  }

  const updated = await updateTaxonomy(db, kind, id, validated.value, new Date().toISOString());

  if (!updated) {
    return internalError();
  }

  logAction(`${kind}.update`, { status: 200 });

  return jsonData(updated);
}

/**
 * 刪除只影響 Hub Metadata。資料庫層已保證：
 *   - 刪除分類 → 專案的 category_id 變成 NULL
 *   - 刪除標籤 → project_tags 的關聯列連帶刪除
 *
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {number} id
 * @returns {Promise<Response>}
 */
async function handleDelete(db, kind, id) {
  const options = OPTIONS[kind];
  const removed = await deleteTaxonomy(db, kind, id);

  if (!removed) {
    return jsonError(404, options.notFoundCode, "Record not found.");
  }

  logAction(`${kind}.delete`, { status: 204 });

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
