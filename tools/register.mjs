/**
 * 把部署結果登錄到 Hub 資料庫（`hub ship` 的第 7 步）。
 *
 * 走 `wrangler d1 execute`，不走 HTTP 管理 API——理由與 `tools/queries.mjs`
 * 一致，見 `tools/d1.mjs` 檔頭「D1 裁定的方案 1」。
 *
 * 依丙方案（2026-08-23 使用者裁定）：
 *   - 新專案（`getProject(slug)` 回 `null`）→ INSERT，**一律 private**，
 *     忽略 `project-hub.json` 裡寫的值。
 *   - 已存在的專案 → UPDATE，**不覆蓋** `visibility`／`name`／`description`／
 *     `platform`／`project_type`／`database_type`／`category_id`／`thumbnail_url`——
 *     那些是後台編輯的內容欄位，重新部署不該悄悄改掉使用者在後台設定的東西。
 *     只更新部署相關欄位：`repository_url`／`worker_name`／`deployment_url`／
 *     `updated_at`／`last_deployed_at`。
 *
 * `build*`／執行分離是既有風格（見 `tools/queries.mjs` 檔頭），純函式部分
 * 可以完全不碰 Wrangler 就測到。
 */

import { executeSql, sqlLiteral } from "./d1.mjs";
import { getProject } from "./queries.mjs";

/**
 * @param {unknown} value
 * @returns {string}
 */
function sqlLiteralOrNull(value) {
  return value === null || value === undefined ? "NULL" : sqlLiteral(value);
}

/**
 * 判斷登錄時該用哪個 visibility。
 *
 * @param {{ visibility: string } | null} existing
 * @returns {string}
 */
export function decideRegisteredVisibility(existing) {
  return existing === null ? "private" : existing.visibility;
}

/**
 * @typedef {{
 *   name: string,
 *   slug: string,
 *   description?: string,
 *   visibility: string,
 *   platform: string,
 *   project_type: string,
 *   database_type?: string,
 *   repository_url?: string | null,
 *   worker_name?: string | null,
 *   deployment_url?: string | null,
 *   thumbnail_url?: string | null,
 *   category_id?: number | null,
 *   version_ref?: string | null,
 * }} ProjectFields
 */

/**
 * 組出登錄用的 SQL。用 `RETURNING id` 直接取得專案 id，不必再查一次
 * （已對本機 D1 實測確認 D1 支援 `RETURNING`）。
 *
 * `fields.visibility` 由呼叫端先用 `decideRegisteredVisibility()` 決定好，
 * 這個函式只管把值放進正確的 SQL 位置，不重複做判斷——判斷邏輯只該有一處。
 *
 * @param {ProjectFields} fields
 * @param {{ id: number } | null} existing
 * @param {string} now ISO 時間字串
 * @returns {string}
 */
export function buildUpsertProjectSql(fields, existing, now) {
  if (existing === null) {
    const columns = [
      "name",
      "slug",
      "description",
      "visibility",
      "platform",
      "project_type",
      "database_type",
      "repository_url",
      "worker_name",
      "deployment_url",
      "thumbnail_url",
      "category_id",
      "created_at",
      "updated_at",
      "last_deployed_at",
    ];

    const values = [
      sqlLiteral(fields.name),
      sqlLiteral(fields.slug),
      sqlLiteral(fields.description ?? ""),
      sqlLiteral(fields.visibility),
      sqlLiteral(fields.platform),
      sqlLiteral(fields.project_type),
      sqlLiteral(fields.database_type ?? "none"),
      sqlLiteralOrNull(fields.repository_url),
      sqlLiteralOrNull(fields.worker_name),
      sqlLiteralOrNull(fields.deployment_url),
      sqlLiteralOrNull(fields.thumbnail_url),
      sqlLiteralOrNull(fields.category_id),
      sqlLiteral(now),
      sqlLiteral(now),
      sqlLiteral(now),
    ];

    return `INSERT INTO projects (${columns.join(", ")}) VALUES (${values.join(", ")}) RETURNING id`;
  }

  return [
    "UPDATE projects SET",
    `repository_url = ${sqlLiteralOrNull(fields.repository_url)},`,
    `worker_name = ${sqlLiteralOrNull(fields.worker_name)},`,
    `deployment_url = ${sqlLiteralOrNull(fields.deployment_url)},`,
    `updated_at = ${sqlLiteral(now)},`,
    `last_deployed_at = ${sqlLiteral(now)}`,
    `WHERE id = ${sqlLiteral(existing.id)}`,
    "RETURNING id",
  ].join(" ");
}

/**
 * 只更新縮圖網址的獨立語句（2026-08-30）。
 *
 * **為什麼不加進上面那條 UPDATE**：那條刻意不覆蓋 `thumbnail_url`，因為
 * 使用者可能在後台自己設過圖，每次部署都蓋掉他的選擇是錯的。
 *
 * 但「使用者這次在專案資料夾裡放了一張新截圖」是一個明確的意圖表達，
 * 那時候就該覆蓋。拆成獨立語句讓這兩種情況分得開：
 * 一般部署完全不碰這個欄位，只有真的裝了新縮圖才呼叫這裡。
 *
 * @param {number} projectId
 * @param {string} thumbnailUrl
 * @param {string} now
 * @returns {string}
 */
export function buildUpdateThumbnailSql(projectId, thumbnailUrl, now) {
  return [
    "UPDATE projects SET",
    `thumbnail_url = ${sqlLiteral(thumbnailUrl)},`,
    `updated_at = ${sqlLiteral(now)}`,
    `WHERE id = ${sqlLiteral(projectId)}`,
  ].join(" ");
}

/**
 * @param {{
 *   project_id: number,
 *   platform: string,
 *   deployment_url: string,
 *   version_ref?: string | null,
 *   status: "success" | "failed" | "rolled_back" | "unknown",
 * }} fields
 * @param {string} now
 * @returns {string}
 */
export function buildInsertDeploymentSql(fields, now) {
  const columns = ["project_id", "platform", "deployment_url", "version_ref", "created_at", "status"];
  const values = [
    sqlLiteral(fields.project_id),
    sqlLiteral(fields.platform),
    sqlLiteral(fields.deployment_url),
    sqlLiteralOrNull(fields.version_ref),
    sqlLiteral(now),
    sqlLiteral(fields.status),
  ];

  return `INSERT INTO deployments (${columns.join(", ")}) VALUES (${values.join(", ")}) RETURNING id`;
}

/**
 * 登錄一次部署：更新／建立 `projects` 那一列，並在 `deployments` 補一筆紀錄。
 *
 * `options.getProject`／`options.executeSql` 是測試用的注入點，預設是真正
 * 呼叫 Wrangler 的版本——跟 `tools/github.mjs` 的 `runCommand` 注入點同一個道理。
 *
 * @param {ProjectFields} fields
 * @param {{
 *   remote?: boolean,
 *   now?: string,
 *   getProject?: typeof getProject,
 *   executeSql?: typeof executeSql,
 * }} [options]
 * @returns {Promise<{ projectId: number, visibility: string, isNew: boolean }>}
 */
export async function registerDeployment(fields, options = {}) {
  const remote = options.remote === true;
  const now = options.now ?? new Date().toISOString();
  const getProjectFn = options.getProject ?? getProject;
  const executeSqlFn = options.executeSql ?? executeSql;

  const existing = await getProjectFn(fields.slug, { remote });
  const visibility = decideRegisteredVisibility(existing);

  const projectSql = buildUpsertProjectSql({ ...fields, visibility }, existing, now);
  const projectRows = await executeSqlFn(projectSql, { remote });
  const projectId = existing ? existing.id : projectRows[0]?.id;

  if (typeof projectId !== "number") {
    throw new Error("登錄專案失敗：資料庫沒有回傳 id，且既有專案查詢也沒有 id 可用。");
  }

  const deploymentSql = buildInsertDeploymentSql(
    {
      project_id: projectId,
      platform: fields.platform,
      deployment_url: fields.deployment_url ?? "",
      version_ref: fields.version_ref ?? null,
      status: "success",
    },
    now,
  );

  await executeSqlFn(deploymentSql, { remote });

  /*
   * 縮圖只在呼叫端明確帶了值時才寫（2026-08-30）。
   *
   * 走獨立語句而不是併進上面那條 UPDATE，理由見 buildUpdateThumbnailSql()：
   * 一般部署不該覆蓋使用者在後台設好的圖，只有「這次真的裝了新縮圖」才覆蓋。
   */
  if (typeof fields.thumbnail_url === "string" && fields.thumbnail_url !== "") {
    await executeSqlFn(buildUpdateThumbnailSql(projectId, fields.thumbnail_url, now), { remote });
  }

  return { projectId, visibility, isNew: existing === null };
}

/**
 * 只確保這個 slug 在資料庫裡有一列可用的 id，**不記錄任何部署**。
 *
 * 用在 `hub ship` 需要在「部署」與「注入閘道」**之前**就知道專案 id 的情境：
 * 閘道設定裡要寫進去的 `project_id` 必須跟資料庫的真實 id 一致，否則之後
 * 簽發出去的工作階段永遠驗不過（`verifySession` 會比對 `project_id`）。
 * 新專案因此需要先在這裡佔一個位子取得 id，再回頭產生閘道設定檔。
 *
 * 已存在的專案直接回傳現有的 id 與 visibility，**不做任何寫入**——
 * 真正記錄這次部署仍然是稍後呼叫 `registerDeployment()` 的責任，
 * 這個函式只負責「確保 id 存在」這一件事，不重複那邊的邏輯。
 *
 * @param {{ name: string, slug: string, platform: string, project_type: string }} fields
 * @param {{
 *   remote?: boolean,
 *   now?: string,
 *   getProject?: typeof getProject,
 *   executeSql?: typeof executeSql,
 * }} [options]
 * @returns {Promise<{ projectId: number, visibility: string, isNew: boolean }>}
 */
export async function ensureProjectRegistered(fields, options = {}) {
  const remote = options.remote === true;
  const getProjectFn = options.getProject ?? getProject;
  const executeSqlFn = options.executeSql ?? executeSql;

  const existing = await getProjectFn(fields.slug, { remote });

  if (existing !== null) {
    return { projectId: existing.id, visibility: existing.visibility, isNew: false };
  }

  const now = options.now ?? new Date().toISOString();
  const sql = buildUpsertProjectSql({ ...fields, visibility: "private" }, null, now);
  const rows = await executeSqlFn(sql, { remote });
  const projectId = rows[0]?.id;

  if (typeof projectId !== "number") {
    throw new Error("預先登錄專案失敗：資料庫沒有回傳 id。");
  }

  return { projectId, visibility: "private", isNew: true };
}
