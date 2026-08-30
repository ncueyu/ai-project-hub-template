import assert from "node:assert/strict";
import test from "node:test";

import { setPrimaryProject } from "../src/repositories/projects.js";

/**
 * 依 SQL 內容回應的假 D1（與 test/gallery.test.mjs 同一種風格）。
 *
 * `setPrimaryProject` 依序做三件事：
 *   1. 確認專案存在（`SELECT id FROM projects WHERE id = ?`）
 *   2. 讀出「目前顯示順序」（`ORDER BY sort_order ASC, updated_at DESC, id DESC`）
 *   3. 用 `db.batch()` 一次寫入新編號，接著呼叫 `getProjectById` 讀回結果
 *
 * 用 SQL 特徵分辨這三種查詢，而不是用先進先出佇列——因為 `getProjectById`
 * 內部也會查一次 `FROM projects WHERE id = ?`，跟步驟 1 的存在檢查很像，
 * 用佇列容易對錯順序。
 *
 * @param {{ existingIds?: number[], orderedIds?: number[] }} options
 */
function createProjectsDatabase({ existingIds = [1], orderedIds = [1] } = {}) {
  const calls = [];
  const batches = [];

  function makeStatement(sql) {
    let params = [];

    const statement = {
      sql,
      get params() {
        return params;
      },
      bind(...args) {
        params = args;
        return statement;
      },
      async first() {
        calls.push({ sql, params, op: "first" });

        // 步驟 1：存在檢查，只 SELECT id。
        if (sql === "SELECT id FROM projects WHERE id = ?") {
          return existingIds.includes(params[0]) ? { id: params[0] } : null;
        }

        // 步驟 3 之後：getProjectById，SELECT 完整欄位清單。
        if (sql.includes("FROM projects WHERE id = ?")) {
          return existingIds.includes(params[0]) ? { id: params[0] } : null;
        }

        return null;
      },
      async all() {
        calls.push({ sql, params, op: "all" });

        // 步驟 2：目前顯示順序。
        if (sql.includes("ORDER BY sort_order ASC, updated_at DESC, id DESC")) {
          return { results: orderedIds.map((id) => ({ id })) };
        }

        // getProjectById → attachTags。
        if (sql.includes("FROM project_tags")) {
          return { results: [] };
        }

        return { results: [] };
      },
      async run() {
        calls.push({ sql, params, op: "run" });
        return { success: true };
      },
    };

    return statement;
  }

  return {
    calls,
    batches,
    prepare(sql) {
      return makeStatement(sql);
    },
    async batch(statements) {
      const snapshot = statements.map((statement) => ({ sql: statement.sql, params: statement.params }));
      batches.push(snapshot);
      return statements.map(() => ({ success: true }));
    },
  };
}

test("setPrimaryProject returns null and writes nothing when the project does not exist", async () => {
  const db = createProjectsDatabase({ existingIds: [1, 2], orderedIds: [1, 2] });

  const result = await setPrimaryProject(db, 999, "2026-08-28T00:00:00Z");

  assert.equal(result, null);
  assert.equal(db.batches.length, 0, "專案不存在時不應該有任何寫入");
});

test("setPrimaryProject sets the target to 1 and renumbers the rest in their existing display order", async () => {
  // 目前顯示順序（模擬 sort_order 全部是預設值 0，因此順序由既有的
  // updated_at DESC, id DESC 決定）：3, 1, 2 ——把 2 設為主卡片。
  const db = createProjectsDatabase({ existingIds: [1, 2, 3], orderedIds: [3, 1, 2] });

  await setPrimaryProject(db, 2, "2026-08-28T00:00:00Z");

  assert.equal(db.batches.length, 1, "整批重新編號必須是同一次 batch");
  const [batch] = db.batches;

  // 目標一定是第一條陳述、sort_order 固定為 1。
  assert.ok(batch[0].sql.includes("SET sort_order = 1"));
  assert.deepEqual(batch[0].params, ["2026-08-28T00:00:00Z", 2]);

  // 其餘專案依「目前顯示順序」排除目標後的相對次序重新編號：3 → 2、1 → 3。
  const restAssignments = batch.slice(1).map((statement) => statement.params);
  assert.deepEqual(restAssignments, [
    [2, 3],
    [3, 1],
  ]);
});

test("setPrimaryProject is idempotent: calling it again with the already-reordered state produces the same numbering", async () => {
  // 第一次呼叫後，展示中心的顯示順序應該已經是「目標在前、其餘照原順序接著」。
  // 這裡直接餵入那個已重排過的順序，模擬「同一個專案被設兩次」。
  const db = createProjectsDatabase({ existingIds: [1, 2, 3], orderedIds: [2, 3, 1] });

  await setPrimaryProject(db, 2, "2026-08-28T00:00:01Z");

  const [batch] = db.batches;
  const restAssignments = batch.slice(1).map((statement) => statement.params);

  // 排除目标後的順序不變（3, 1），編號依然是 2, 3——與第一次呼叫的結果一致，
  // 不會因為重複呼叫而愈設愈亂。
  assert.deepEqual(restAssignments, [
    [2, 3],
    [3, 1],
  ]);
});

test("setPrimaryProject moving the primary status from one project to another keeps the previous primary near the front, not at the back", async () => {
  // 承接上一個測試的結果（2 是主卡片，顯示順序 2, 3, 1）。現在改把 3 設為主卡片。
  const db = createProjectsDatabase({ existingIds: [1, 2, 3], orderedIds: [2, 3, 1] });

  await setPrimaryProject(db, 3, "2026-08-28T00:00:02Z");

  const [batch] = db.batches;
  assert.ok(batch[0].sql.includes("SET sort_order = 1"));
  assert.deepEqual(batch[0].params, ["2026-08-28T00:00:02Z", 3]);

  const restAssignments = batch.slice(1).map((statement) => statement.params);

  // 排除 3 後的原順序是 2, 1——原本的主卡片 2 排在第一個，因此拿到 2，
  // 不再是主卡片，但沒有被丟到最後。
  assert.deepEqual(restAssignments, [
    [2, 2],
    [3, 1],
  ]);
});
