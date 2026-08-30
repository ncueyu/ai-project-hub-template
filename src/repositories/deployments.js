// @ts-check

/**
 * 部署紀錄的資料存取層。
 *
 * 這一層**只記錄別人已經完成的事**。Hub 不執行部署、不做還原、不刪除
 * 任何外部資源，也不呼叫 Cloudflare 或 GitHub 的 API（見計畫第 10.6 節）。
 * 實際的部署動作屬於階段三的 `hub deploy`。
 */

const COLUMNS = "id, project_id, platform, deployment_url, version_ref, created_at, status";

/** 可記錄的部署結果。 */
export const DEPLOYMENT_STATUSES = Object.freeze([
  "success",
  "failed",
  "rolled_back",
  "unknown",
]);

/**
 * 列出某專案的部署紀錄，最新的在前。
 *
 * @param {D1Database} db
 * @param {number} projectId
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listDeployments(db, projectId, options = {}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM deployments
       WHERE project_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(projectId, limit)
    .all();

  return result.results ?? [];
}

/**
 * 新增一筆部署紀錄。
 *
 * 只有 `success` 會同時更新專案的對外網址與最後部署時間，而且兩件事
 * 放在同一個批次中執行，避免出現「紀錄寫進去了、專案卻沒更新」的狀態。
 *
 * 失敗或還原的紀錄**不會**覆蓋最後一次成功的網址——否則一次失敗的部署
 * 就會讓展示中心指向錯誤的位置。
 *
 * @param {D1Database} db
 * @param {number} projectId
 * @param {{ platform: string, deployment_url: string, version_ref?: string | null, status: string }} value
 * @param {string} now
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function createDeployment(db, projectId, value, now) {
  const insert = db
    .prepare(
      `INSERT INTO deployments (project_id, platform, deployment_url, version_ref, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(projectId, value.platform, value.deployment_url, value.version_ref ?? null, now, value.status);

  if (value.status === "success") {
    await db.batch([
      insert,
      db
        .prepare("UPDATE projects SET deployment_url = ?, last_deployed_at = ?, updated_at = ? WHERE id = ?")
        .bind(value.deployment_url, now, now, projectId),
    ]);
  } else {
    await db.batch([insert]);
  }

  const created = await db
    .prepare(
      `SELECT ${COLUMNS} FROM deployments
       WHERE project_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .bind(projectId)
    .first();

  return created;
}
