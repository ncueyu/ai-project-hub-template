/**
 * 階段 A 的唯讀查詢。
 *
 * 兩個安全原則貫穿本檔：
 *
 * 1. **欄位一律列名，不使用 `SELECT *`。** 這不只是風格問題——`project_policies`
 *    存有密碼雜湊，而 MCP 工具的輸出會直接進入 AI 的脈絡。列名讓「哪些欄位
 *    會外流」變成一眼可查的事實，而不是要靠追查資料表結構才能確認。
 *    本檔**完全不查詢 `project_policies`**。
 *
 * 2. **所有外部輸入先驗證形狀，再跳脫。** `wrangler d1 execute` 無法傳遞
 *    繫結參數（見 `d1.mjs` 的 sqlLiteral），而 MCP 的參數由 AI 產生，
 *    必須當成不可信輸入處理。
 *
 * SQL 組裝與執行刻意分開：`build*` 是純函式，可以單獨測試而不必真的
 * 啟動 Wrangler。
 */

import { VISIBILITY_STATES } from "../src/visibility.js";
import { executeSql, sqlLiteral } from "./d1.mjs";

/** 對外公開的專案欄位。新增欄位前先問：這個欄位可以讓 AI 看到嗎？ */
export const PROJECT_COLUMNS = Object.freeze([
  "p.id",
  "p.name",
  "p.slug",
  "p.description",
  "p.visibility",
  "p.platform",
  "p.project_type",
  "p.database_type",
  "p.repository_url",
  "p.deployment_url",
  "p.worker_name",
  "p.thumbnail_url",
  "p.created_at",
  "p.updated_at",
  "p.last_deployed_at",
]);

export const DEPLOYMENT_COLUMNS = Object.freeze([
  "d.id",
  "d.platform",
  "d.deployment_url",
  "d.version_ref",
  "d.status",
  "d.created_at",
]);

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 80;

/**
 * @param {unknown} value
 * @returns {number}
 */
export function assertProjectId(value) {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;

  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error("專案編號必須是大於 0 的整數。");
  }

  return id;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function assertSlug(value) {
  if (typeof value !== "string" || value.length > SLUG_MAX || !SLUG_PATTERN.test(value)) {
    throw new Error("代稱只能包含小寫英數字與連字號，例如 my-project。");
  }

  return value;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function assertLimit(value) {
  if (value === undefined || value === null) {
    return DEFAULT_LIMIT;
  }

  const limit = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;

  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`筆數必須是 1 到 ${MAX_LIMIT} 之間的整數。`);
  }

  return limit;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function assertVisibility(value) {
  if (typeof value !== "string" || !VISIBILITY_STATES.includes(value)) {
    throw new Error(`可見性只能是下列其中之一：${VISIBILITY_STATES.join("、")}。`);
  }

  return value;
}

/**
 * 把「編號或代稱」統一成 WHERE 條件。
 *
 * 使用者與 AI 都比較容易記得代稱，但編號在指令輸出中更短。兩種都接受，
 * 由值的形狀決定用哪一種，不需要使用者另外指定。
 *
 * @param {string | number} identifier
 * @returns {string}
 */
export function buildIdentifierCondition(identifier) {
  if (typeof identifier === "number" || /^\d+$/.test(String(identifier))) {
    return `p.id = ${sqlLiteral(assertProjectId(identifier))}`;
  }

  return `p.slug = ${sqlLiteral(assertSlug(identifier))}`;
}

/**
 * @param {{ visibility?: string, limit?: number }} [options]
 * @returns {string}
 */
export function buildListProjectsSql(options = {}) {
  const limit = assertLimit(options.limit);
  const conditions = [];

  if (options.visibility !== undefined) {
    conditions.push(`p.visibility = ${sqlLiteral(assertVisibility(options.visibility))}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return [
    `SELECT ${PROJECT_COLUMNS.join(", ")}, c.name AS category_name`,
    "FROM projects p",
    "LEFT JOIN categories c ON c.id = p.category_id",
    where,
    "ORDER BY p.updated_at DESC, p.id DESC",
    `LIMIT ${limit}`,
  ].filter(Boolean).join(" ");
}

/**
 * @param {string | number} identifier
 * @returns {string}
 */
export function buildGetProjectSql(identifier) {
  return [
    `SELECT ${PROJECT_COLUMNS.join(", ")}, c.name AS category_name`,
    "FROM projects p",
    "LEFT JOIN categories c ON c.id = p.category_id",
    `WHERE ${buildIdentifierCondition(identifier)}`,
    "LIMIT 1",
  ].join(" ");
}

/**
 * @param {string | number} identifier
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function buildDeploymentStatusSql(identifier, options = {}) {
  const limit = assertLimit(options.limit ?? 10);

  return [
    `SELECT ${DEPLOYMENT_COLUMNS.join(", ")}, p.slug AS project_slug`,
    "FROM deployments d",
    "JOIN projects p ON p.id = d.project_id",
    `WHERE ${buildIdentifierCondition(identifier)}`,
    "ORDER BY d.created_at DESC, d.id DESC",
    `LIMIT ${limit}`,
  ].join(" ");
}

/**
 * @param {{ visibility?: string, limit?: number, remote?: boolean }} [options]
 * @returns {Promise<Record<string, any>[]>}
 */
export async function listProjects(options = {}) {
  return executeSql(buildListProjectsSql(options), { remote: options.remote });
}

/**
 * @param {string | number} identifier
 * @param {{ remote?: boolean }} [options]
 * @returns {Promise<Record<string, any> | null>}
 */
export async function getProject(identifier, options = {}) {
  const rows = await executeSql(buildGetProjectSql(identifier), { remote: options.remote });

  return rows[0] ?? null;
}

/**
 * 取得部署狀態。
 *
 * 專案不存在與「專案存在但從未部署」是兩件事，回傳結構刻意區分：
 * 前者回 null，後者回空陣列。混為一談會讓使用者以為專案不見了。
 *
 * @param {string | number} identifier
 * @param {{ limit?: number, remote?: boolean }} [options]
 * @returns {Promise<{ project: Record<string, any>, deployments: Record<string, any>[] } | null>}
 */
export async function getDeploymentStatus(identifier, options = {}) {
  const project = await getProject(identifier, { remote: options.remote });

  if (!project) {
    return null;
  }

  const deployments = await executeSql(
    buildDeploymentStatusSql(identifier, { limit: options.limit }),
    { remote: options.remote },
  );

  return { project, deployments };
}
