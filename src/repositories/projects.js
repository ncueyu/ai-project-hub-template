// @ts-check

/**
 * Projects 的資料存取層。
 *
 * 規則：
 *   - 所有值一律使用 Prepared Statement 的 bind，絕不做 SQL 字串拼接。
 *   - 本層不回傳 `project_policies` 的任何欄位，密碼雜湊不會流出這一層。
 *   - 本層只操作 Hub 的 D1 Metadata，不呼叫任何外部平台 API。
 */

/** 對外可回傳的專案欄位。`project_policies` 的欄位一律不在此列。 */
const PROJECT_COLUMNS = [
  "id",
  "name",
  "slug",
  "description",
  "visibility",
  "category_id",
  "repository_url",
  "worker_name",
  "platform",
  "deployment_url",
  "project_type",
  "database_type",
  "thumbnail_url",
  // 2026-08-28 主畫面改造 Part D 新增：後台清單要能標示「目前是主卡片」，
  // 需要讀到 sort_order 本身（公開展示中心走另一份欄位清單
  // `repositories/gallery.js` 的 `PUBLIC_COLUMNS`，只輸出換算後的
  // `is_primary` 布林值，不受這裡影響）。
  "sort_order",
  "created_at",
  "updated_at",
  "last_deployed_at",
].join(", ");

/** PATCH 允許寫入的欄位白名單，避免呼叫端傳入非預期的欄位名稱。 */
const UPDATABLE_COLUMNS = new Set([
  "name",
  "slug",
  "description",
  "visibility",
  "category_id",
  "repository_url",
  "worker_name",
  "platform",
  "deployment_url",
  "project_type",
  "database_type",
  "thumbnail_url",
  /*
   * 2026-09-06 加入。在此之前 sort_order 只能被 setPrimaryProject() 間接改寫，
   * 管理者無法指定任一張卡片的位置。格式驗證在 src/validation.js 的
   * validateProjectPatch（非負整數）。
   */
  "sort_order",
]);

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/**
 * 將使用者輸入轉為安全的 LIKE pattern。
 * `%` 與 `_` 是 LIKE 的萬用字元，必須跳脫後再比對。
 *
 * @param {string} term
 * @returns {string}
 */
function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * @param {D1Database} db
 * @param {{ limit?: number, offset?: number, visibility?: string | null, categoryId?: number | null, q?: string | null }} options
 * @returns {Promise<{ items: Record<string, unknown>[], total: number }>}
 */
export async function listProjects(db, options = {}) {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  const conditions = [];
  const params = [];

  if (options.visibility) {
    conditions.push("visibility = ?");
    params.push(options.visibility);
  }

  if (options.categoryId !== null && options.categoryId !== undefined) {
    conditions.push("category_id = ?");
    params.push(options.categoryId);
  }

  if (options.q) {
    conditions.push("(name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\')");
    const pattern = likePattern(options.q);
    params.push(pattern, pattern);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM projects ${where}`)
    .bind(...params)
    .first();

  const listed = await db
    .prepare(
      /*
       * 排序與展示中心一致（2026-09-06 改；原本是 `updated_at DESC, id DESC`）。
       *
       * 這條 SQL 餵的是後台的專案清單，而後台正是管理者用來**調整顯示順序**的
       * 地方。兩邊排法不同的話，他改完序號回到清單，看到的還是舊的排列——
       * 無從判斷自己改對了沒有，只能跑去展示中心對照。
       *
       * 與 `src/repositories/gallery.js` 的 ORDER BY 刻意逐字相同。
       * 改一邊而忘了另一邊不會有任何錯誤訊息，只會讓兩個畫面靜靜地不一致。
       */
      `SELECT ${PROJECT_COLUMNS} FROM projects ${where}
       ORDER BY sort_order ASC, updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all();

  const items = listed.results ?? [];
  await attachTags(db, items);

  return {
    items,
    total: Number(countRow?.total ?? 0),
  };
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getProjectById(db, id) {
  const row = await db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
    .bind(id)
    .first();

  if (!row) {
    return null;
  }

  const items = [row];
  await attachTags(db, items);

  return items[0];
}

/**
 * 為一批專案補上 tags 陣列。
 *
 * @param {D1Database} db
 * @param {Record<string, unknown>[]} projects
 * @returns {Promise<void>}
 */
async function attachTags(db, projects) {
  for (const project of projects) {
    project.tags = [];
  }

  if (projects.length === 0) {
    return;
  }

  const ids = projects.map((project) => project.id);
  const placeholders = ids.map(() => "?").join(", ");

  const rows = await db
    .prepare(
      `SELECT pt.project_id AS project_id, t.id AS id, t.name AS name, t.slug AS slug
       FROM project_tags pt
       JOIN tags t ON t.id = pt.tag_id
       WHERE pt.project_id IN (${placeholders})
       ORDER BY t.name ASC`,
    )
    .bind(...ids)
    .all();

  const byProject = new Map();

  for (const row of rows.results ?? []) {
    const list = byProject.get(row.project_id) ?? [];
    list.push({ id: row.id, name: row.name, slug: row.slug });
    byProject.set(row.project_id, list);
  }

  for (const project of projects) {
    project.tags = byProject.get(project.id) ?? [];
  }
}

/**
 * @param {D1Database} db
 * @param {string} slug
 * @param {number} [excludeId]
 * @returns {Promise<boolean>}
 */
export async function slugExists(db, slug, excludeId) {
  const row = excludeId
    ? await db.prepare("SELECT id FROM projects WHERE slug = ? AND id != ?").bind(slug, excludeId).first()
    : await db.prepare("SELECT id FROM projects WHERE slug = ?").bind(slug).first();

  return Boolean(row);
}

/**
 * @param {D1Database} db
 * @param {Record<string, any>} value
 * @param {string} now ISO-8601 UTC
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function createProject(db, value, now) {
  const inserted = await db
    .prepare(
      /*
       * sort_order 用純量子查詢取「目前最大值 + 1」，而不是讓它吃欄位預設的 0
       * （2026-09-06）。
       *
       * 0 加上展示中心的 `ORDER BY sort_order ASC`，等於每一個新專案都插到
       * 管理者排好的順序最前面。2026-09-06 實測：主卡片被當天新增的四個專案
       * 擠到第 5 位，而畫面上完全看不出原因。
       *
       * 建立專案有兩條路（後台的 POST /api/projects 走這裡，`hub ship` 走
       * `tools/register.mjs`），兩條都要做同一件事——只修一邊的話，另一邊
       * 進來的專案照樣插隊，而且同樣沒有錯誤訊息。
       */
      `INSERT INTO projects (
         name, slug, description, visibility, category_id,
         repository_url, worker_name, platform, deployment_url,
         project_type, database_type, thumbnail_url,
         sort_order, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects), ?, ?
       )
       RETURNING id`,
    )
    .bind(
      value.name,
      value.slug,
      value.description ?? "",
      value.visibility,
      value.category_id ?? null,
      value.repository_url ?? null,
      value.worker_name ?? null,
      value.platform,
      value.deployment_url ?? null,
      value.project_type,
      value.database_type,
      value.thumbnail_url ?? null,
      now,
      now,
    )
    .first();

  if (!inserted) {
    return null;
  }

  const id = Number(inserted.id);

  if (Array.isArray(value.tag_ids) && value.tag_ids.length > 0) {
    await replaceProjectTags(db, id, value.tag_ids);
  }

  return getProjectById(db, id);
}

/**
 * 只更新 payload 中明確出現的欄位。
 *
 * @param {D1Database} db
 * @param {number} id
 * @param {Record<string, any>} value
 * @param {string} now
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function updateProject(db, id, value, now) {
  const assignments = [];
  const params = [];

  for (const [column, columnValue] of Object.entries(value)) {
    if (!UPDATABLE_COLUMNS.has(column)) {
      continue;
    }

    assignments.push(`${column} = ?`);
    params.push(columnValue);
  }

  if (assignments.length > 0) {
    assignments.push("updated_at = ?");
    params.push(now, id);

    await db
      .prepare(`UPDATE projects SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...params)
      .run();
  } else if ("tag_ids" in value) {
    // 只換標籤時，仍要更新 updated_at 以維持排序語意正確。
    await db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now, id).run();
  }

  if ("tag_ids" in value) {
    await replaceProjectTags(db, id, value.tag_ids ?? []);
  }

  return getProjectById(db, id);
}

/**
 * 以 batch 一次替換標籤關聯，避免刪除成功但新增失敗的中間狀態。
 *
 * @param {D1Database} db
 * @param {number} projectId
 * @param {number[]} tagIds
 * @returns {Promise<void>}
 */
export async function replaceProjectTags(db, projectId, tagIds) {
  const statements = [
    db.prepare("DELETE FROM project_tags WHERE project_id = ?").bind(projectId),
  ];

  for (const tagId of tagIds) {
    statements.push(
      db
        .prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)")
        .bind(projectId, tagId),
    );
  }

  await db.batch(statements);
}

/**
 * 把指定專案設為「主卡片」：該專案的 `sort_order` 變成 1，其餘專案依照
 * 目前的顯示順序重新編號成 2、3、4……（2026-08-28 工作計畫 Part D）。
 *
 * 為什麼不是單純把目標設成 1、其他人完全不動：
 *   `sort_order` 的中性預設值是 0（見 migrations/0003 的檔頭說明），而展示
 *   中心的排序是 `ORDER BY sort_order ASC, ...`——如果目標設成 1、其他人
 *   維持 0，0 會排在 1 之前，主卡片反而變成排在其他專案後面。因此「其他
 *   依序往後」不只是需求描述，而是讓排序方向正確的必要條件：其他專案必須
 *   全部拿到大於 1 的值。
 *
 * 為什麼用「目前顯示順序」而不是「id 順序」決定其他專案的新編號：
 *   這樣重新整理過的順序與使用者在展示中心目前看到的順序一致，不會因為
 *   換一個主卡片就讓本來排前面的專案突然掉到後面。
 *
 * 並發／重複呼叫的處理方式：
 *   - 整批重新編號用 `db.batch()` 一次送出，D1 會把整批視為一個原子操作，
 *     不會有「編到一半」被另一個請求插隊的中間狀態。
 *   - 重複對同一個專案呼叫兩次是自然的不動點（fixed point）：第一次呼叫後
 *     目標已經是排序最前面的 1，第二次呼叫重新讀出的顯示順序不會變，算出
 *     來的編號跟上一次完全相同，不會愈設愈亂。
 *   - 先設 A 再設 B：A 在「目前顯示順序」裡已經排最前面，B 呼叫時把 A
 *     排除後、A 仍會是「其他專案」裡的第一個，因此 A 會拿到 2（不是被丟到
 *     最後）——A 不再是主卡片，但仍保持在很前面，符合「换主卡片」的直覺。
 *
 * @param {D1Database} db
 * @param {number} id
 * @param {string} now ISO-8601 UTC
 * @returns {Promise<Record<string, unknown> | null>} 專案不存在時回 null
 */
export async function setPrimaryProject(db, id, now) {
  const existing = await db.prepare("SELECT id FROM projects WHERE id = ?").bind(id).first();

  if (!existing) {
    return null;
  }

  // 目前的顯示順序——與 `repositories/gallery.js` 的 ORDER BY 同一個排法，
  // 但這裡要含全部專案（不限公開狀態），因為後台看到的是所有專案。
  const ordered = await db
    .prepare("SELECT id FROM projects ORDER BY sort_order ASC, updated_at DESC, id DESC")
    .all();

  const restIds = (ordered.results ?? [])
    .map((row) => Number(row.id))
    .filter((projectId) => projectId !== id);

  const statements = [
    db.prepare("UPDATE projects SET sort_order = 1, updated_at = ? WHERE id = ?").bind(now, id),
    ...restIds.map((projectId, index) =>
      db.prepare("UPDATE projects SET sort_order = ? WHERE id = ?").bind(index + 2, projectId),
    ),
  ];

  await db.batch(statements);

  return getProjectById(db, id);
}

/**
 * 只刪除 Hub 的 Metadata。不觸碰 Worker、Repository 或 Deployment。
 *
 * **已知缺口（2026-08-30，縮圖改存 D1 之後才出現）**：這裡也不會刪掉該專案的
 * 縮圖位元組。`thumbnail_blobs`／`thumbnail_chunks` 是以 object_key 為主鍵、
 * 沒有指向 `projects` 的外鍵，所以刪掉專案之後那張圖會留在資料庫裡沒有人指向它。
 * 影響是慢慢吃掉 D1 的配額（免費方案單一資料庫 500 MB），而且前端完全看不出來。
 * 縮圖上限 1 MB，要累積到有感需要刪掉數百個帶圖的專案，因此不緊急，
 * 但**這是一個真的洩漏，不是設計**。修法：在這裡沿用
 * `parseOwnThumbnailKey()` 判斷是不是自己存的縮圖，是的話一併刪掉。
 *
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<boolean>}
 */
export async function deleteProject(db, id) {
  const existing = await db.prepare("SELECT id FROM projects WHERE id = ?").bind(id).first();

  if (!existing) {
    return false;
  }

  await db.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();

  return true;
}
