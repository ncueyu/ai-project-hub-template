// @ts-check

/**
 * Categories 與 Tags 的資料存取層。
 *
 * 兩者結構高度相似，因此共用同一組函式，並以 `kind` 選取資料表設定。
 * `kind` 只能取自本檔案內的常數，永遠不來自使用者輸入，因此資料表名稱
 * 直接內插不構成 SQL Injection 風險；所有「值」仍一律使用 bind。
 */

/** @typedef {"categories" | "tags"} TaxonomyKind */

const TABLES = Object.freeze({
  categories: {
    table: "categories",
    columns: "id, name, slug, description, sort_order, created_at, updated_at",
    orderBy: "sort_order ASC, name ASC",
    insertColumns: ["name", "slug", "description", "sort_order"],
  },
  tags: {
    table: "tags",
    columns: "id, name, slug, created_at, updated_at",
    orderBy: "name ASC",
    insertColumns: ["name", "slug"],
  },
});

/**
 * @param {TaxonomyKind} kind
 */
function config(kind) {
  const found = TABLES[kind];

  if (!found) {
    throw new Error(`Unknown taxonomy kind: ${kind}`);
  }

  return found;
}

/**
 * 每一筆額外附上 project_count——目前有幾個專案在用它。
 *
 * 後台刪除分類或標籤前要先告訴使用者影響範圍：刪掉分類會讓那些專案
 * 變成「未分類」，刪掉標籤會讓關聯直接消失。沒有這個數字，確認對話框
 * 只能顯示名稱，使用者無從判斷該不該按下去。
 *
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listTaxonomy(db, kind) {
  const { table, columns, orderBy } = config(kind);

  const usage = kind === "categories"
    ? `(SELECT COUNT(*) FROM projects WHERE projects.category_id = ${table}.id)`
    : `(SELECT COUNT(*) FROM project_tags WHERE project_tags.tag_id = ${table}.id)`;

  const result = await db
    .prepare(`SELECT ${columns}, ${usage} AS project_count FROM ${table} ORDER BY ${orderBy}`)
    .all();

  return result.results ?? [];
}

/**
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {number} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getTaxonomyById(db, kind, id) {
  const { table, columns } = config(kind);

  return db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`).bind(id).first();
}

/**
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {string} slug
 * @param {number} [excludeId]
 * @returns {Promise<boolean>}
 */
export async function taxonomySlugExists(db, kind, slug, excludeId) {
  const { table } = config(kind);

  const row = excludeId
    ? await db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`).bind(slug, excludeId).first()
    : await db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).bind(slug).first();

  return Boolean(row);
}

/**
 * 名稱是否已經被用掉。
 *
 * 代稱只出現在網址上，重複了使用者看不到；名稱則是使用者在下拉選單裡
 * 唯一的判斷依據。允許同名會產生兩個外觀完全一樣的分類，專案被拆到
 * 不同分類卻沒人看得出來——所以名稱也要唯一。
 *
 * 比對時去掉前後空白並忽略大小寫（SQLite 的 LOWER 只處理 ASCII，
 * 對中文沒有作用，也不需要）。
 *
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {string} name
 * @param {number} [excludeId]
 * @returns {Promise<boolean>}
 */
export async function taxonomyNameExists(db, kind, name, excludeId) {
  const { table } = config(kind);
  const condition = "LOWER(TRIM(name)) = LOWER(TRIM(?))";

  const row = excludeId
    ? await db.prepare(`SELECT id FROM ${table} WHERE ${condition} AND id != ?`).bind(name, excludeId).first()
    : await db.prepare(`SELECT id FROM ${table} WHERE ${condition}`).bind(name).first();

  return Boolean(row);
}

/**
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {Record<string, any>} value
 * @param {string} now
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function createTaxonomy(db, kind, value, now) {
  const { table, insertColumns } = config(kind);
  const columns = [...insertColumns, "created_at", "updated_at"];
  const placeholders = columns.map(() => "?").join(", ");

  const params = insertColumns.map((column) => {
    if (column === "description") return value.description ?? "";
    if (column === "sort_order") return value.sort_order ?? 0;
    return value[column];
  });

  const inserted = await db
    .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`)
    .bind(...params, now, now)
    .first();

  if (!inserted) {
    return null;
  }

  return getTaxonomyById(db, kind, Number(inserted.id));
}

/**
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {number} id
 * @param {Record<string, any>} value
 * @param {string} now
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function updateTaxonomy(db, kind, id, value, now) {
  const { table, insertColumns } = config(kind);
  const allowed = new Set(insertColumns);

  const assignments = [];
  const params = [];

  for (const [column, columnValue] of Object.entries(value)) {
    if (!allowed.has(column)) {
      continue;
    }

    assignments.push(`${column} = ?`);
    params.push(columnValue);
  }

  if (assignments.length > 0) {
    assignments.push("updated_at = ?");
    params.push(now, id);

    await db.prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`).bind(...params).run();
  }

  return getTaxonomyById(db, kind, id);
}

/**
 * 只刪除 Hub Metadata。
 * 資料庫層已定義：刪除分類會把專案的 category_id 設為 NULL；
 * 刪除標籤會連帶刪除 project_tags 的關聯列。
 *
 * @param {D1Database} db
 * @param {TaxonomyKind} kind
 * @param {number} id
 * @returns {Promise<boolean>}
 */
export async function deleteTaxonomy(db, kind, id) {
  const { table } = config(kind);
  const existing = await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();

  if (!existing) {
    return false;
  }

  await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();

  return true;
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<boolean>}
 */
export async function categoryExists(db, id) {
  const row = await db.prepare("SELECT id FROM categories WHERE id = ?").bind(id).first();

  return Boolean(row);
}

/**
 * 回傳不存在的 Tag ID 清單，供 route 層組出欄位級錯誤訊息。
 *
 * @param {D1Database} db
 * @param {number[]} tagIds
 * @returns {Promise<number[]>}
 */
export async function findMissingTagIds(db, tagIds) {
  if (!Array.isArray(tagIds) || tagIds.length === 0) {
    return [];
  }

  const placeholders = tagIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(`SELECT id FROM tags WHERE id IN (${placeholders})`)
    .bind(...tagIds)
    .all();

  const found = new Set((rows.results ?? []).map((row) => Number(row.id)));

  return tagIds.filter((id) => !found.has(id));
}
