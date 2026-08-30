import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInsertDeploymentSql,
  buildUpsertProjectSql,
  decideRegisteredVisibility,
  ensureProjectRegistered,
  registerDeployment,
} from "../tools/register.mjs";

const NOW = "2026-08-25T12:00:00.000Z";

test("decideRegisteredVisibility: new project is always private, ignoring whatever the caller passed", () => {
  assert.equal(decideRegisteredVisibility(null), "private");
});

test("decideRegisteredVisibility: existing project keeps its current visibility untouched", () => {
  assert.equal(decideRegisteredVisibility({ id: 1, visibility: "public" }), "public");
  assert.equal(decideRegisteredVisibility({ id: 1, visibility: "password" }), "password");
});

test("buildUpsertProjectSql: a new project inserts every column and returns id", () => {
  const sql = buildUpsertProjectSql(
    {
      name: "電阻色碼互動練習",
      slug: "resistor-quiz",
      description: "示範",
      visibility: "private",
      platform: "cloudflare",
      project_type: "static",
      repository_url: "https://github.com/ncueyu/resistor-quiz",
      worker_name: "resistor-quiz",
      deployment_url: "https://resistor-quiz.example.workers.dev",
    },
    null,
    NOW,
  );

  assert.match(sql, /^INSERT INTO projects/);
  assert.match(sql, /RETURNING id$/);
  assert.match(sql, /'private'/, "新專案一律 private");
  assert.match(sql, /'resistor-quiz'/);
  assert.match(sql, /'2026-08-25T12:00:00\.000Z'/);
});

test("buildUpsertProjectSql: fields absent from the manifest fall back to safe defaults, not undefined leaking into SQL", () => {
  const sql = buildUpsertProjectSql(
    { name: "t", slug: "t", visibility: "private", platform: "cloudflare", project_type: "static" },
    null,
    NOW,
  );

  assert.match(sql, /''/, "description 預設空字串");
  assert.match(sql, /'none'/, "database_type 預設 none");
  assert.equal(sql.includes("undefined"), false);
  assert.equal(sql.includes("NULL"), true, "repository_url 等未填欄位應為 NULL");
});

test("buildUpsertProjectSql: an existing project only updates deployment-related columns", () => {
  const sql = buildUpsertProjectSql(
    {
      name: "改了名字也不該生效",
      slug: "resistor-quiz",
      visibility: "public",
      platform: "cloudflare",
      project_type: "static",
      repository_url: "https://github.com/ncueyu/resistor-quiz",
      worker_name: "resistor-quiz",
      deployment_url: "https://resistor-quiz.example.workers.dev/v2",
    },
    { id: 42, visibility: "public" },
    NOW,
  );

  assert.match(sql, /^UPDATE projects SET/);
  assert.match(sql, /WHERE id = 42/);
  assert.match(sql, /RETURNING id$/);

  // 只碰部署相關欄位——身份／內容欄位完全不該出現在 SET 子句裡。
  for (const column of ["name", "description", "visibility", "platform", "project_type", "database_type", "category_id", "thumbnail_url"]) {
    assert.equal(new RegExp(`\\b${column}\\s*=`).test(sql), false, `UPDATE 不該碰 ${column}`);
  }

  assert.match(sql, /deployment_url = 'https:\/\/resistor-quiz\.example\.workers\.dev\/v2'/);
});

test("buildInsertDeploymentSql produces a parameterised-looking append-only insert", () => {
  const sql = buildInsertDeploymentSql(
    { project_id: 42, platform: "cloudflare", deployment_url: "https://x.workers.dev", version_ref: "abc123", status: "success" },
    NOW,
  );

  assert.match(sql, /^INSERT INTO deployments/);
  assert.match(sql, /'abc123'/);
  assert.match(sql, /'success'/);
  assert.match(sql, /RETURNING id$/);
});

test("buildInsertDeploymentSql: a null version_ref becomes SQL NULL, not the string 'null'", () => {
  const sql = buildInsertDeploymentSql(
    { project_id: 1, platform: "cloudflare", deployment_url: "https://x.workers.dev", version_ref: null, status: "success" },
    NOW,
  );

  assert.match(sql, /NULL/);
  assert.equal(sql.includes("'null'"), false);
});

// ── registerDeployment：全流程，透過假的 getProject／executeSql 注入 ──

function makeFakeExecuteSql(calls, { insertedId = 99 } = {}) {
  return async (sql, options) => {
    calls.push({ sql, options });

    if (sql.startsWith("INSERT INTO projects")) {
      return [{ id: insertedId }];
    }

    return [];
  };
}

test("registerDeployment: a brand-new project inserts with private and returns isNew=true", async () => {
  const calls = [];
  const result = await registerDeployment(
    {
      name: "新專案",
      slug: "brand-new",
      platform: "cloudflare",
      project_type: "static",
      deployment_url: "https://brand-new.example.workers.dev",
    },
    {
      now: NOW,
      getProject: async () => null,
      executeSql: makeFakeExecuteSql(calls, { insertedId: 7 }),
    },
  );

  assert.deepEqual(result, { projectId: 7, visibility: "private", isNew: true });
  assert.equal(calls.length, 2, "應該有兩次寫入：專案本身 ＋ 部署紀錄");
  assert.match(calls[0].sql, /^INSERT INTO projects/);
  assert.match(calls[1].sql, /^INSERT INTO deployments/);
  assert.match(calls[1].sql, /VALUES \(7,/, "部署紀錄要指到剛剛拿到的 id");
});

test("registerDeployment: an existing project updates without touching visibility, and reports isNew=false", async () => {
  const calls = [];
  const result = await registerDeployment(
    {
      name: "既有專案",
      slug: "already-there",
      platform: "cloudflare",
      project_type: "static",
      deployment_url: "https://already-there.example.workers.dev/v3",
    },
    {
      now: NOW,
      getProject: async () => ({ id: 55, visibility: "password" }),
      executeSql: makeFakeExecuteSql(calls),
    },
  );

  assert.deepEqual(result, { projectId: 55, visibility: "password", isNew: false });
  assert.match(calls[0].sql, /^UPDATE projects/);
  assert.match(calls[0].sql, /WHERE id = 55/);
  assert.equal(calls[0].sql.includes("visibility ="), false);
});

test("registerDeployment: throws instead of silently registering a deployment against no project id", async () => {
  await assert.rejects(
    registerDeployment(
      { name: "t", slug: "t", platform: "cloudflare", project_type: "static" },
      {
        now: NOW,
        getProject: async () => null,
        executeSql: async () => [{}], // 沒有 id 欄位——模擬 RETURNING 失效
      },
    ),
    /沒有回傳 id/,
  );
});

test("registerDeployment passes remote through to both getProject and executeSql", async () => {
  const seenRemote = [];

  await registerDeployment(
    { name: "t", slug: "remote-check", platform: "cloudflare", project_type: "static" },
    {
      now: NOW,
      remote: true,
      getProject: async (slug, options) => {
        seenRemote.push(["getProject", options.remote]);
        return null;
      },
      executeSql: async (sql, options) => {
        seenRemote.push(["executeSql", options.remote]);
        return [{ id: 1 }];
      },
    },
  );

  assert.ok(seenRemote.every(([, remote]) => remote === true), "remote 選項要一路傳到底");
});

// ── ensureProjectRegistered：hub ship 需要在部署／注入閘道前先拿到真實 id ──

test("ensureProjectRegistered: an existing project returns its real id without writing anything", async () => {
  const calls = [];
  const result = await ensureProjectRegistered(
    { name: "t", slug: "already-there", platform: "cloudflare", project_type: "static" },
    {
      now: NOW,
      getProject: async () => ({ id: 55, visibility: "public" }),
      executeSql: async (sql) => {
        calls.push(sql);
        return [];
      },
    },
  );

  assert.deepEqual(result, { projectId: 55, visibility: "public", isNew: false });
  assert.equal(calls.length, 0, "既有專案不該有任何寫入");
});

test("ensureProjectRegistered: a brand-new project is inserted as private with no deployment_url yet", async () => {
  const calls = [];
  const result = await ensureProjectRegistered(
    { name: "全新專案", slug: "brand-new-reserve", platform: "cloudflare", project_type: "static" },
    {
      now: NOW,
      getProject: async () => null,
      executeSql: async (sql) => {
        calls.push(sql);
        return [{ id: 8 }];
      },
    },
  );

  assert.deepEqual(result, { projectId: 8, visibility: "private", isNew: true });
  assert.equal(calls.length, 1, "只該有一次寫入——建立這一列，不記錄部署");
  assert.match(calls[0], /^INSERT INTO projects/);
  assert.match(calls[0], /'private'/);
  assert.match(calls[0], /NULL/, "deployment_url 此時還不知道，應為 NULL");
});

test("ensureProjectRegistered: throws instead of silently returning a fake id when RETURNING gives nothing", async () => {
  await assert.rejects(
    ensureProjectRegistered(
      { name: "t", slug: "t", platform: "cloudflare", project_type: "static" },
      { now: NOW, getProject: async () => null, executeSql: async () => [{}] },
    ),
    /沒有回傳 id/,
  );
});

test("ensureProjectRegistered is idempotent: calling it again after the project now exists returns the same id and writes nothing more", async () => {
  const calls = [];
  const fields = { name: "t", slug: "idempotent-check", platform: "cloudflare", project_type: "static" };

  const first = await ensureProjectRegistered(fields, {
    now: NOW,
    getProject: async () => null,
    executeSql: async (sql) => {
      calls.push(sql);
      return [{ id: 3 }];
    },
  });

  const second = await ensureProjectRegistered(fields, {
    now: NOW,
    getProject: async () => ({ id: 3, visibility: "private" }),
    executeSql: async (sql) => {
      calls.push(sql);
      return [];
    },
  });

  // isNew 理應不同：第一次是真的建立，第二次是發現它已經存在。
  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  assert.equal(first.projectId, second.projectId, "兩次拿到的必須是同一個 id");
  assert.equal(first.visibility, second.visibility);
  assert.equal(calls.length, 1, "第二次呼叫（此時已存在）不該再寫入");
});
