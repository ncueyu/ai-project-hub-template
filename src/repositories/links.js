// @ts-check

/**
 * 推薦連結（links）的資料存取層。
 *
 * 連結是獨立於 projects 的頂層實體（理由見 `migrations/0002_links_and_settings.sql`
 * 檔頭），因此這裡不共用 `repositories/projects.js` 的任何函式：
 *   - 後台 CRUD 走這裡的管理函式，回傳全部欄位（含 `is_listed`）。
 *   - 公開展示中心只能看到 `is_listed = 1` 的連結，且輸出欄位比照
 *     `repositories/gallery.js` 的 `shapePublicProjects`——只回可公開的欄位，
 *     `is_listed` 本身是內部狀態旗標，不對外輸出。
 */

/** 後台可回傳的完整欄位。 */
const ADMIN_COLUMNS = "id, category_id, name, url, description, icon, sort_order, is_listed, created_at, updated_at";

/** PATCH 允許寫入的欄位白名單，避免呼叫端傳入非預期的欄位名稱。 */
const UPDATABLE_COLUMNS = new Set([
  "category_id",
  "name",
  "url",
  "description",
  "icon",
  "sort_order",
  "is_listed",
]);

/**
 * 後台清單。排序邏輯與公開查詢（`listPublicLinks`）一致，讓管理者在後台
 * 看到的順序跟展示中心相同，不會出現「後台改了排序，展示中心看起來卻沒變」。
 *
 * @param {D1Database} db
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listLinks(db) {
  const result = await db
    .prepare(`SELECT ${ADMIN_COLUMNS} FROM links ORDER BY sort_order ASC, name ASC`)
    .all();

  return result.results ?? [];
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getLinkById(db, id) {
  return db.prepare(`SELECT ${ADMIN_COLUMNS} FROM links WHERE id = ?`).bind(id).first();
}

/**
 * @param {D1Database} db
 * @param {Record<string, any>} value
 * @param {string} now ISO-8601 UTC
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function createLink(db, value, now) {
  const inserted = await db
    .prepare(
      `INSERT INTO links (
         category_id, name, url, description, icon, sort_order, is_listed, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      value.category_id ?? null,
      value.name,
      value.url,
      value.description ?? "",
      value.icon ?? "",
      value.sort_order ?? 0,
      value.is_listed === false ? 0 : 1,
      now,
      now,
    )
    .first();

  if (!inserted) {
    return null;
  }

  return getLinkById(db, Number(inserted.id));
}

/**
 * 只更新 payload 中明確出現的欄位（與 `repositories/taxonomy.js` 同慣例）。
 *
 * @param {D1Database} db
 * @param {number} id
 * @param {Record<string, any>} value
 * @param {string} now
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function updateLink(db, id, value, now) {
  const assignments = [];
  const params = [];

  for (const [column, columnValue] of Object.entries(value)) {
    if (!UPDATABLE_COLUMNS.has(column)) {
      continue;
    }

    assignments.push(`${column} = ?`);
    // is_listed 在驗證層是布林值，資料庫欄位是 0/1 整數（CHECK IN (0, 1)），
    // 這裡是唯一負責轉換的地方。
    params.push(column === "is_listed" ? (columnValue ? 1 : 0) : columnValue);
  }

  if (assignments.length > 0) {
    assignments.push("updated_at = ?");
    params.push(now, id);

    await db.prepare(`UPDATE links SET ${assignments.join(", ")} WHERE id = ?`).bind(...params).run();
  }

  return getLinkById(db, id);
}

/**
 * 只刪除連結本身。刪除分類時連結不會被連帶刪除——`category_id` 的外鍵是
 * `ON DELETE SET NULL`，由資料庫層保證，這裡不需要處理。
 *
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<boolean>}
 */
export async function deleteLink(db, id) {
  const existing = await db.prepare("SELECT id FROM links WHERE id = ?").bind(id).first();

  if (!existing) {
    return false;
  }

  await db.prepare("DELETE FROM links WHERE id = ?").bind(id).run();

  return true;
}

// ---------------------------------------------------------------------------
// 公開查詢
// ---------------------------------------------------------------------------

/**
 * Gallery 可對外公開的欄位。`is_listed` 只用來組出 WHERE 條件，
 * 不會出現在對外回應裡（見 `shapePublicLinks`）。
 */
const PUBLIC_COLUMNS = `
  l.id AS id,
  l.name AS name,
  l.url AS url,
  l.description AS description,
  l.icon AS icon,
  c.id AS category_id,
  c.name AS category_name,
  c.slug AS category_slug
`;

/**
 * 展示中心用的公開查詢。只回傳 `is_listed = 1` 的連結，依 `sort_order`
 * 再依 `name` 排序——與後台清單同一套排序邏輯。
 *
 * @param {D1Database} db
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listPublicLinks(db) {
  const result = await db
    .prepare(
      `SELECT ${PUBLIC_COLUMNS}
       FROM links l
       LEFT JOIN categories c ON c.id = l.category_id
       WHERE l.is_listed = 1
       ORDER BY l.sort_order ASC, l.name ASC`,
    )
    .all();

  return shapePublicLinks(result.results ?? []);
}

/**
 * 把資料庫的扁平欄位整理成對外的形狀，並確保不夾帶多餘欄位。
 *
 * @param {Record<string, any>[]} rows
 * @returns {Record<string, unknown>[]}
 */
function shapePublicLinks(rows) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description,
    icon: row.icon,
    category: row.category_id
      ? { id: row.category_id, name: row.category_name, slug: row.category_slug }
      : null,
  }));
}
