// @ts-check

import { internalError, jsonData, jsonError, methodNotAllowed, readJsonBody, rejectCrossSite } from "../http.js";
import { getPolicy, setPolicyPassword } from "../repositories/policies.js";
import { hashPassword } from "../access-gate/password.js";

/** 密碼最短長度。低重複次數的雜湊更依賴密碼本身的長度來抵抗破解。 */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

/**
 * 專案存取政策 API。
 *
 * 這是管理用 API，正式環境由 `src/admin-gate.js` 的密碼閘道保護。
 * 回應永遠不包含密碼雜湊，只回傳「有沒有設密碼」。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {number} projectId
 * @returns {Promise<Response>}
 */
export async function handlePolicy(request, db, projectId) {
  if (request.method === "PUT") {
    const rejected = rejectCrossSite(request);

    if (rejected) {
      return rejected;
    }
  }

  try {
    const project = await db
      .prepare("SELECT id FROM projects WHERE id = ?")
      .bind(projectId)
      .first();

    if (!project) {
      return jsonError(404, "PROJECT_NOT_FOUND", "Project not found.");
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const policy = await getPolicy(db, projectId);

      // 尚未建立政策時回傳預設形狀，讓管理介面不必特別處理 null。
      return jsonData(policy ?? {
        project_id: projectId,
        policy_version: 0,
        updated_at: null,
        has_password: false,
      });
    }

    if (request.method !== "PUT") {
      return methodNotAllowed(["GET", "HEAD", "PUT"]);
    }

    const body = await readJsonBody(request);

    if (body.response) {
      return body.response;
    }

    const raw = body.value.password;

    // 明確傳 null 代表移除密碼。
    if (raw === null) {
      const updated = await setPolicyPassword(db, projectId, null, new Date().toISOString());

      logPolicyChange(projectId, "cleared", updated);

      return jsonData(updated);
    }

    if (typeof raw !== "string") {
      return jsonError(400, "VALIDATION_FAILED", "Password payload is invalid.", {
        password: "必須是文字，或傳 null 以移除密碼。",
      });
    }

    if (raw.length < MIN_PASSWORD_LENGTH || raw.length > MAX_PASSWORD_LENGTH) {
      return jsonError(400, "VALIDATION_FAILED", "Password length is out of range.", {
        password: `長度必須介於 ${MIN_PASSWORD_LENGTH} 到 ${MAX_PASSWORD_LENGTH} 個字元。`,
      });
    }

    // 雜湊運算只在這裡發生。受保護專案的一般請求不會經過這段程式。
    const hash = await hashPassword(raw);
    const updated = await setPolicyPassword(db, projectId, hash, new Date().toISOString());

    logPolicyChange(projectId, "updated", updated);

    return jsonData(updated);
  } catch (error) {
    console.log(JSON.stringify({
      action: "policy.internal_error",
      project_id: projectId,
      status: 500,
      code: "INTERNAL_ERROR",
    }));

    return internalError();
  }
}

/**
 * 只記錄結構化結果。密碼、雜湊與鹽值一律不進記錄。
 *
 * @param {number} projectId
 * @param {string} outcome
 * @param {Record<string, unknown> | null} policy
 */
function logPolicyChange(projectId, outcome, policy) {
  console.log(JSON.stringify({
    action: `policy.${outcome}`,
    project_id: projectId,
    policy_version: policy?.policy_version ?? null,
    status: 200,
  }));
}
