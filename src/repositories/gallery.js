// @ts-check

/**
 * 公開展示中心的資料存取層。
 *
 * 這一層與管理用的 `repositories/projects.js` 刻意分開，原因見階段二計畫第 4.3 節：
 * 管理 API 會回傳完整 Metadata，Gallery 不能共用它。
 *
 * 硬性規則：
 *   - 查詢條件永遠限定在 `GALLERY_LISTED_STATES`（`public` 與 `password`），
 *     且該條件在**模組載入時**就固定成字串常數，不由呼叫端決定。
 *     2026-08-23 之前這裡只認 `public` 且各處各自寫死；改為由 `visibility.js`
 *     單一來源產生，避免兩份定義悄悄走位（漏改不會報錯，首頁只會靜靜顯示錯的東西）。
 *   - 只 SELECT 可公開的欄位。`repository_url`、`worker_name`、`project_policies`
 *     的任何欄位都不在查詢範圍內，因此不可能流到瀏覽器。
 *   - `visibility` 原值**不對外輸出**，只輸出 `requires_password` 布林值：
 *     前端只需要知道要不要顯示標記，不需要知道權限狀態。
 *   - 篩選用的分類與標籤清單，統計範圍必須與專案查詢**完全一致**；否則加密專案
 *     的分類不會出現在篩選選單裡，那個專案就等於被篩選功能藏起來了。
 */

import { GALLERY_LISTED_STATES, requiresPasswordToOpen } from "../visibility.js";

/**
 * 把可列出的狀態組成 SQL 的 IN 條件。
 *
 * 在模組載入時算一次，結果是固定字串——呼叫端無從影響，等同於寫死在 SQL 內。
 * 仍然逐一驗證每個值只含小寫字母：這些值來自本專案的常數而非使用者輸入，
 * 但這裡是唯一一處把識別字串接進 SQL 的地方，擋住比信任省事。
 */
const LISTED_VISIBILITY_SQL = `p.visibility IN (${GALLERY_LISTED_STATES.map((state) => {
  if (!/^[a-z]+$/.test(state)) {
    throw new Error(`可見性狀態含非預期字元，拒絕組進 SQL：${state}`);
  }
  return `'${state}'`;
}).join(", ")})`;

/**
 * Gallery 可對外公開的欄位。
 *
 * `visibility` 只用來算出 `requires_password`，不會出現在對外回應裡
 * （見 `shapePublicProjects`）。
 *
 * 這段說明刻意放在 JS 註解而不是 SQL 內的 `/* *​/` 區塊註解裡：
 * 註解寫進查詢字串會被一路帶到資料庫驅動層，而各層對註解的處理並不一致。
 */
const PUBLIC_COLUMNS = `
  p.id AS id,
  p.name AS name,
  p.slug AS slug,
  p.visibility AS visibility,
  p.description AS description,
  p.deployment_url AS deployment_url,
  p.thumbnail_url AS thumbnail_url,
  p.project_type AS project_type,
  p.sort_order AS sort_order,
  p.updated_at AS updated_at,
  p.last_deployed_at AS last_deployed_at,
  c.id AS category_id,
  c.name AS category_name,
  c.slug AS category_slug
`;

/**
 * @param {D1Database} db
 * @param {{ category?: string | null, tag?: string | null }} filters
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listPublicProjects(db, filters = {}) {
  const conditions = [LISTED_VISIBILITY_SQL];
  const params = [];

  if (filters.category) {
    conditions.push("c.slug = ?");
    params.push(filters.category);
  }

  if (filters.tag) {
    conditions.push(`EXISTS (
      SELECT 1 FROM project_tags pt
      JOIN tags t ON t.id = pt.tag_id
      WHERE pt.project_id = p.id AND t.slug = ?
    )`);
    params.push(filters.tag);
  }

  const result = await db
    .prepare(
      `SELECT ${PUBLIC_COLUMNS}
       FROM projects p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.sort_order ASC, p.updated_at DESC, p.id DESC`,
    )
    .bind(...params)
    .all();

  const rows = result.results ?? [];

  return shapePublicProjects(await attachPublicTags(db, rows));
}

/**
 * 為 public 專案補上標籤。
 *
 * @param {D1Database} db
 * @param {Record<string, any>[]} rows
 * @returns {Promise<Record<string, any>[]>}
 */
async function attachPublicTags(db, rows) {
  for (const row of rows) {
    row.tags = [];
  }

  if (rows.length === 0) {
    return rows;
  }

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(", ");

  const tagRows = await db
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

  for (const tag of tagRows.results ?? []) {
    const list = byProject.get(tag.project_id) ?? [];
    list.push({ id: tag.id, name: tag.name, slug: tag.slug });
    byProject.set(tag.project_id, list);
  }

  for (const row of rows) {
    row.tags = byProject.get(row.id) ?? [];
  }

  return rows;
}

/**
 * 把資料庫的扁平欄位整理成對外的形狀，並確保不夾帶多餘欄位。
 *
 * @param {Record<string, any>[]} rows
 * @returns {Record<string, unknown>[]}
 */
function shapePublicProjects(rows) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    deployment_url: row.deployment_url,
    thumbnail_url: row.thumbnail_url,

    // project_type 是可公開的分類資訊，不是機密：
    // 展示中心需要它才能標示「這不是可直接開啟的網站」——
    // 桌面程式與瀏覽器擴充功能的卡片若和一般網站長得一樣，
    // 訪客會按下「開啟」期待看到應用程式，結果拿到一張說明頁。
    project_type: row.project_type,

    // 只輸出「是不是主卡片」的布林值，不輸出 sort_order 原始數字——
    // 前端只需要知道要不要畫七彩光暈，不需要知道背後的排序機制
    // （2026-08-28 工作計畫 Part D）。sort_order = 1 是
    // `setPrimaryProject` 寫入主卡片時固定使用的值，見該函式註解。
    is_primary: Number(row.sort_order) === 1,

    // 只輸出「要不要標記」，不輸出 visibility 原值。
    // 能列出的狀態只有 public 與 password 兩種，所以一個布林值已經足夠表達。
    requires_password: requiresPasswordToOpen(row.visibility),
    updated_at: row.updated_at,
    last_deployed_at: row.last_deployed_at,
    category: row.category_id
      ? { id: row.category_id, name: row.category_name, slug: row.category_slug }
      : null,
    tags: row.tags ?? [],
  }));
}

/**
 * 數出「存在但不會出現在展示中心」的專案數量。**只回數字，不回任何細節。**
 *
 * 為什麼需要這個：新專案登錄時一律是 `private`（`tools/register.mjs` 的
 * `decideRegisteredVisibility()`，刻意的安全預設），而展示中心只列出
 * `public` 與 `password`。所以使用者成功部署第一個專案之後，展示中心
 * **仍然是空的**——如果空狀態畫面只會說「還沒有專案，去部署一個吧」，
 * 他會以為部署失敗了。有了這個數字，畫面才能改口說「你有 1 個專案，
 * 但它是私人狀態，到後台改成公開就會出現」。
 *
 * ## 為什麼只回數字，而且只在需要時才回
 *
 * 這是**公開** API，任何訪客都能呼叫。回傳「有幾個未公開專案」本身就是一點
 * 資訊揭露——所以這裡的契約刻意收得很緊：
 *
 *   - 只有數量，沒有名稱、網址、縮圖、分類，也沒有 `visibility` 原值。
 *     光看這個數字無法得知那些專案是什麼、更無法存取它們。
 *   - 呼叫端（`src/routes/gallery.js`）只在「可列出的專案數為 0」時才輸出它。
 *     有東西可看的時候，這個數字對訪客沒有任何用途，就不給。
 *
 * 這個收斂是 2026-08-29 主動加的（裁決原文只要求「多回未公開專案數量」），
 * 已在回報中向使用者說明。
 *
 * @param {D1Database} db
 * @returns {Promise<number>}
 */
export async function countUnlistedProjects(db) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM projects p WHERE NOT (${LISTED_VISIBILITY_SQL})`)
    .first();

  const total = Number(row?.total ?? 0);

  // 防禦性下限：COUNT(*) 不該是負數或 NaN，但這個值會直接影響畫面文案，
  // 壞值會讓使用者看到「你有 NaN 個專案」這種比留白更糟的訊息。
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * 篩選選項。統計範圍與專案查詢一致（`GALLERY_LISTED_STATES`），
 * 未列出的狀態不計入，避免洩漏「有其他非公開專案存在」這件事。
 *
 * @param {D1Database} db
 * @returns {Promise<{ categories: Record<string, unknown>[], tags: Record<string, unknown>[] }>}
 */
export async function listPublicFilters(db) {
  const categories = await db
    .prepare(
      `SELECT c.id AS id, c.name AS name, c.slug AS slug, COUNT(p.id) AS count
       FROM categories c
       JOIN projects p ON p.category_id = c.id AND ${LISTED_VISIBILITY_SQL}
       GROUP BY c.id, c.name, c.slug
       ORDER BY c.sort_order ASC, c.name ASC`,
    )
    .all();

  const tags = await db
    .prepare(
      `SELECT t.id AS id, t.name AS name, t.slug AS slug, COUNT(p.id) AS count
       FROM tags t
       JOIN project_tags pt ON pt.tag_id = t.id
       JOIN projects p ON p.id = pt.project_id AND ${LISTED_VISIBILITY_SQL}
       GROUP BY t.id, t.name, t.slug
       ORDER BY t.name ASC`,
    )
    .all();

  return {
    categories: categories.results ?? [],
    tags: tags.results ?? [],
  };
}
