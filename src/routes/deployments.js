// @ts-check

import { internalError, jsonData, jsonError, methodNotAllowed, readJsonBody, rejectCrossSite } from "../http.js";
import { DEPLOYMENT_STATUSES, createDeployment, listDeployments } from "../repositories/deployments.js";
import { PLATFORMS } from "../validation.js";

/**
 * 部署紀錄 API。
 *
 * Hub 只登錄結果，不執行任何部署動作。這個檔案裡沒有、也不應該有
 * 對外部平台 API 的呼叫。
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {URL} url
 * @param {number} projectId
 * @returns {Promise<Response>}
 */
export async function handleDeployments(request, db, url, projectId) {
  if (request.method === "POST") {
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
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : Number(rawLimit);

      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        return jsonError(400, "VALIDATION_FAILED", "Query parameters are invalid.", {
          limit: "必須是 1 到 100 之間的整數。",
        });
      }

      return jsonData({ items: await listDeployments(db, projectId, { limit }) });
    }

    if (request.method !== "POST") {
      return methodNotAllowed(["GET", "HEAD", "POST"]);
    }

    const body = await readJsonBody(request);

    if (body.response) {
      return body.response;
    }

    const validated = validateDeployment(body.value);

    if (!validated.ok) {
      return jsonError(400, "VALIDATION_FAILED", "Deployment payload is invalid.", validated.fields);
    }

    const created = await createDeployment(db, projectId, validated.value, new Date().toISOString());

    if (!created) {
      return internalError();
    }

    console.log(JSON.stringify({
      action: "deployment.record",
      project_id: projectId,
      status: 201,
      code: null,
    }));

    return jsonData(created, 201);
  } catch (error) {
    console.log(JSON.stringify({
      action: "deployment.internal_error",
      project_id: projectId,
      status: 500,
      code: "INTERNAL_ERROR",
    }));

    return internalError();
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: any } | { ok: false, fields: Record<string, string> }}
 */
function validateDeployment(input) {
  /** @type {Record<string, string>} */
  const fields = {};

  let platform;

  if (typeof input.platform === "string" && PLATFORMS.includes(input.platform)) {
    platform = input.platform;
  } else {
    fields.platform = `只能是下列其中之一：${PLATFORMS.join("、")}。`;
  }

  let status;

  if (typeof input.status === "string" && DEPLOYMENT_STATUSES.includes(input.status)) {
    status = input.status;
  } else {
    fields.status = `只能是下列其中之一：${DEPLOYMENT_STATUSES.join("、")}。`;
  }

  let deploymentUrl;

  if (typeof input.deployment_url !== "string" || input.deployment_url.trim() === "") {
    fields.deployment_url = "請填寫部署後的網址。";
  } else {
    try {
      const parsed = new URL(input.deployment_url);

      if (parsed.protocol !== "https:") {
        fields.deployment_url = "只接受 https 開頭的網址。";
      } else {
        deploymentUrl = input.deployment_url;
      }
    } catch {
      fields.deployment_url = "不是有效的網址。";
    }
  }

  let versionRef = null;

  if (input.version_ref !== undefined && input.version_ref !== null && input.version_ref !== "") {
    if (typeof input.version_ref !== "string" || input.version_ref.length > 200) {
      fields.version_ref = "必須是 200 個字元以內的文字。";
    } else {
      versionRef = input.version_ref;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: { platform, deployment_url: deploymentUrl, version_ref: versionRef, status },
  };
}
