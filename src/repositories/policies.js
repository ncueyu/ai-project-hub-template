// @ts-check

/**
 * 專案存取政策的資料存取層。
 *
 * `project_policies` 是密碼雜湊與政策版本的**唯一**來源，展示用的專案
 * 中繼資料不存這些欄位（見計畫第 9.5 節）。
 *
 * 政策版本的用途：擁有者改密碼後，所有已發出的工作階段必須立刻失效。
 * 作法是把版本號寫進工作階段權杖，閘道每次比對；版本一變，舊權杖全部不符。
 *
 * 因此「更新雜湊」與「版本加一」**必須在同一個資料庫操作中完成**。
 * 若分成兩步，中間的空窗期會讓舊工作階段仍可通行；若第二步失敗，
 * 密碼已經改了但舊工作階段永遠有效——那是更糟的狀態。
 */

/** 對外可回傳的政策欄位。`password_hash` 永遠不在此列。 */
const SAFE_COLUMNS = "project_id, policy_version, updated_at, (password_hash IS NOT NULL) AS has_password";

/**
 * 讀取政策摘要。不回傳密碼雜湊本身，只回傳「有沒有設密碼」。
 *
 * @param {D1Database} db
 * @param {number} projectId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getPolicy(db, projectId) {
  const row = await db
    .prepare(`SELECT ${SAFE_COLUMNS} FROM project_policies WHERE project_id = ?`)
    .bind(projectId)
    .first();

  if (!row) {
    return null;
  }

  return {
    project_id: row.project_id,
    policy_version: row.policy_version,
    updated_at: row.updated_at,
    has_password: Boolean(row.has_password),
  };
}

/**
 * 只在需要驗證密碼時使用，回傳雜湊本身。
 *
 * 呼叫端必須確保這個值不會出現在任何 API 回應、記錄或錯誤訊息中。
 *
 * @param {D1Database} db
 * @param {number} projectId
 * @returns {Promise<{ password_hash: string | null, policy_version: number } | null>}
 */
export async function getPolicySecret(db, projectId) {
  const row = await db
    .prepare("SELECT password_hash, policy_version FROM project_policies WHERE project_id = ?")
    .bind(projectId)
    .first();

  if (!row) {
    return null;
  }

  return {
    password_hash: /** @type {string | null} */ (row.password_hash),
    policy_version: Number(row.policy_version),
  };
}

/**
 * 設定或變更密碼，並在同一個語句中把版本加一。
 *
 * 使用 upsert：政策不存在時建立（版本從 1 開始），已存在時更新雜湊並遞增版本。
 * 整段是單一 SQL 敘述，資料庫保證它要嘛全部成功、要嘛全部不動。
 *
 * @param {D1Database} db
 * @param {number} projectId
 * @param {string | null} passwordHash 傳 null 代表移除密碼
 * @param {string} now
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function setPolicyPassword(db, projectId, passwordHash, now) {
  await db
    .prepare(
      `INSERT INTO project_policies (project_id, policy_version, password_hash, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         password_hash = excluded.password_hash,
         policy_version = project_policies.policy_version + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(projectId, passwordHash, now)
    .run();

  return getPolicy(db, projectId);
}

/**
 * 在不變更密碼的情況下讓既有工作階段失效。
 *
 * 用於「改了重要存取設定，但密碼不變」的情況，例如把可見性從
 * password 改成 private 之後又改回來。
 *
 * @param {D1Database} db
 * @param {number} projectId
 * @param {string} now
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function bumpPolicyVersion(db, projectId, now) {
  await db
    .prepare(
      `INSERT INTO project_policies (project_id, policy_version, password_hash, updated_at)
       VALUES (?, 1, NULL, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         policy_version = project_policies.policy_version + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(projectId, now)
    .run();

  return getPolicy(db, projectId);
}
