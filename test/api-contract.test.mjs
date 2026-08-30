import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { importSigningKey, issueSession } from "../src/access-gate/session.js";
import { ADMIN_PROJECT_ID, ADMIN_POLICY_VERSION } from "../src/admin-gate.js";

/**
 * 2026-08-25 起 `/api/projects`／`categories`／`tags` 多了一道登入閘道
 * （`src/admin-gate.js`，取代原計畫的 Cloudflare Access）。本檔測的是這些
 * 路由「登入之後」的業務邏輯契約（驗證、SQL 注入防護、409 衝突等），
 * 閘道本身的行為由 `test/admin-gate.test.mjs` 涵蓋——所以這裡的請求
 * 一律先帶上一個有效的管理員 session，不重新測閘道擋不擋。
 */
const TEST_SIGNING_KEY_SECRET = "api-contract-test-signing-key-do-not-use-0123456789";
let adminSessionCookie;

test.before(async () => {
  const signingKey = await importSigningKey(TEST_SIGNING_KEY_SECRET);
  const token = await issueSession(signingKey, {
    project_id: ADMIN_PROJECT_ID,
    policy_version: ADMIN_POLICY_VERSION,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  adminSessionCookie = `hub_admin_session=${token}`;
});

/**
 * 會記錄每一次查詢的假 D1。
 *
 * 目的不是模擬 SQLite，而是讓測試能斷言兩件事：
 *   1. 路由在錯誤情境下是否在碰資料庫之前就回應。
 *   2. 使用者輸入是否確實走 bind 參數，而不是被拼進 SQL 字串。
 *
 * 真實 SQL 行為（CHECK、UNIQUE、FOREIGN KEY）已於 TASK-2.2 以本機 D1 實測驗證。
 */
function createRecordingDatabase({ first = [], all = [] } = {}) {
  const calls = [];
  const firstQueue = [...first];
  const allQueue = [...all];

  function createStatement(sql) {
    let params = [];

    return {
      sql,
      bind(...args) {
        params = args;
        return this;
      },
      async first() {
        calls.push({ sql, params, op: "first" });
        return firstQueue.length > 0 ? firstQueue.shift() : null;
      },
      async all() {
        calls.push({ sql, params, op: "all" });
        return allQueue.length > 0 ? allQueue.shift() : { results: [] };
      },
      async run() {
        calls.push({ sql, params, op: "run" });
        return { success: true };
      },
    };
  }

  return {
    calls,
    prepare(sql) {
      return createStatement(sql);
    },
    async batch(statements) {
      for (const statement of statements) {
        calls.push({ sql: statement.sql, params: [], op: "batch" });
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

function createEnv(db) {
  return {
    // 這一組測試針對的是管理 API 的契約，因此明確開啟管理介面。
    // 「關閉時應完全不存在」的行為由 test/admin-gate.test.mjs 涵蓋。
    ADMIN_ENABLED: "true",
    SESSION_SIGNING_KEY: TEST_SIGNING_KEY_SECRET,
    ASSETS: { fetch: async () => new Response("STATIC") },
    ...(db ? { DB: db } : {}),
  };
}

function apiRequest(path, init = {}) {
  const headers = init.body !== undefined
    ? { "Content-Type": "application/json", Cookie: adminSessionCookie, ...init.headers }
    : { Cookie: adminSessionCookie, ...init.headers };

  return new Request(`https://hub.example.test${path}`, { ...init, headers });
}

test("api routes return 503 when the D1 binding is missing", async () => {
  const response = await worker.fetch(apiRequest("/api/projects"), createEnv(null));

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "DATABASE_NOT_CONFIGURED");
});

test("health check works without a database binding", async () => {
  const response = await worker.fetch(apiRequest("/api/health"), createEnv(null));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("unknown api resources return 404", async () => {
  const response = await worker.fetch(
    apiRequest("/api/unknown"),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "NOT_FOUND");
});

test("unsupported methods on the collection return 405 with Allow", async () => {
  const response = await worker.fetch(
    apiRequest("/api/projects", { method: "PUT", body: "{}" }),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, POST");
});

test("unsupported methods on a single project return 405 with Allow", async () => {
  const response = await worker.fetch(
    apiRequest("/api/projects/1", { method: "POST", body: "{}" }),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, PATCH, DELETE");
});

test("a non-numeric project id is treated as not found", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(apiRequest("/api/projects/abc"), createEnv(db));

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "PROJECT_NOT_FOUND");
  assert.equal(db.calls.length, 0, "無效 ID 不應觸發任何查詢");
});

test("cross-site mutations are blocked before touching the database", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "x", slug: "x", visibility: "public", platform: "cloudflare" }),
      headers: { "Sec-Fetch-Site": "cross-site" },
    }),
    createEnv(db),
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "CROSS_SITE_FORBIDDEN");
  assert.equal(db.calls.length, 0, "跨站請求不應觸發任何查詢");
});

test("invalid json is rejected before touching the database", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/projects", { method: "POST", body: "{oops" }),
    createEnv(db),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_JSON");
  assert.equal(db.calls.length, 0);
});

test("validation failures list every offending field", async () => {
  const response = await worker.fetch(
    apiRequest("/api/projects", { method: "POST", body: JSON.stringify({}) }),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, "VALIDATION_FAILED");
  assert.ok(body.error.fields.name);
  assert.ok(body.error.fields.slug);
  assert.ok(body.error.fields.visibility);
  assert.ok(body.error.fields.platform);
});

test("a duplicate slug is reported as 409 rather than 500", async () => {
  const db = createRecordingDatabase({ first: [{ id: 7 }] });
  const response = await worker.fetch(
    apiRequest("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "重複",
        slug: "taken-slug",
        visibility: "public",
        platform: "cloudflare",
      }),
    }),
    createEnv(db),
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "SLUG_CONFLICT");
});

test("invalid list query parameters are rejected", async () => {
  for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?offset=-1", "?visibility=nope", "?category_id=0"]) {
    const response = await worker.fetch(
      apiRequest(`/api/projects${query}`),
      createEnv(createRecordingDatabase()),
    );

    assert.equal(response.status, 400, `應拒絕 ${query}`);
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  }
});

test("sql injection payloads travel as bound parameters, never as sql text", async () => {
  const payload = "'; DROP TABLE projects; --";
  const db = createRecordingDatabase({
    first: [
      null,          // slugExists：查無重複
      { id: 1 },     // INSERT ... RETURNING id
      { id: 1, name: payload, slug: "safe-slug" }, // getProjectById
    ],
    all: [{ results: [] }], // attachTags
  });

  const response = await worker.fetch(
    apiRequest("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: payload,
        slug: "safe-slug",
        visibility: "public",
        platform: "cloudflare",
        description: payload,
      }),
    }),
    createEnv(db),
  );

  assert.equal(response.status, 201);

  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO projects"));
  assert.ok(insert, "應該有一次 INSERT");
  assert.equal(insert.sql.includes(payload), false, "payload 不可出現在 SQL 字串中");
  assert.ok(insert.params.includes(payload), "payload 必須以 bind 參數傳遞");

  for (const call of db.calls) {
    assert.equal(call.sql.includes("DROP TABLE"), false, "任何 SQL 都不應含注入內容");
  }
});

test("search terms are escaped so like wildcards cannot leak through", async () => {
  const db = createRecordingDatabase({ first: [{ total: 0 }], all: [{ results: [] }] });

  const response = await worker.fetch(
    apiRequest("/api/projects?q=100%_test"),
    createEnv(db),
  );

  assert.equal(response.status, 200);

  const search = db.calls.find((call) => call.sql.includes("LIKE"));
  assert.ok(search, "應該有一次 LIKE 查詢");
  assert.ok(
    search.params.some((param) => typeof param === "string" && param.includes("100\\%\\_test")),
    "LIKE 萬用字元必須被跳脫",
  );
});

test("deleting a missing project returns 404 and never calls an external api", async () => {
  const db = createRecordingDatabase({ first: [null] });
  const response = await worker.fetch(
    apiRequest("/api/projects/999", { method: "DELETE" }),
    createEnv(db),
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "PROJECT_NOT_FOUND");

  const deletes = db.calls.filter((call) => call.sql.includes("DELETE"));
  assert.equal(deletes.length, 0, "找不到專案時不應執行刪除");
});

// ---------------------------------------------------------------- 設為主卡片

test("only PUT is allowed on the primary sub-resource", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/projects/1/primary", { method: "DELETE" }),
    createEnv(db),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "PUT");
  assert.equal(db.calls.length, 0, "方法不允許時不應觸碰資料庫");
});

test("cross-site PUT to primary is blocked before touching the database", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/projects/1/primary", {
      method: "PUT",
      headers: { "Sec-Fetch-Site": "cross-site" },
    }),
    createEnv(db),
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "CROSS_SITE_FORBIDDEN");
  assert.equal(db.calls.length, 0, "跨站請求不應觸發任何查詢");
});

test("setting a missing project as primary returns 404 and writes nothing", async () => {
  const db = createRecordingDatabase({ first: [null] });
  const response = await worker.fetch(
    apiRequest("/api/projects/999/primary", { method: "PUT" }),
    createEnv(db),
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "PROJECT_NOT_FOUND");
  assert.equal(db.calls.filter((call) => call.op === "batch").length, 0);
});

test("setting an existing project as primary batches the renumbering and returns the updated project", async () => {
  const db = createRecordingDatabase({
    // 依序對應：存在檢查 → getProjectById（batch 之後讀回結果）。
    first: [{ id: 1 }, { id: 1, name: "電阻色碼互動練習", sort_order: 1 }],
    // 依序對應：目前顯示順序 → getProjectById 內的 attachTags。
    all: [{ results: [{ id: 1 }, { id: 2 }] }, { results: [] }],
  });

  const response = await worker.fetch(
    apiRequest("/api/projects/1/primary", { method: "PUT" }),
    createEnv(db),
  );

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.data.id, 1);
  assert.equal(body.data.sort_order, 1);

  const batchCalls = db.calls.filter((call) => call.op === "batch");
  assert.ok(
    batchCalls.some((call) => call.sql.includes("SET sort_order = 1")),
    "應該有一條把目標設成 sort_order = 1 的陳述",
  );
  assert.ok(
    batchCalls.some((call) => call.sql.includes("SET sort_order = ?")),
    "應該有陳述把其他專案往後編號",
  );
});

test("taxonomy single-record routes only allow patch and delete", async () => {
  for (const resource of ["categories", "tags"]) {
    const response = await worker.fetch(
      apiRequest(`/api/${resource}/1`),
      createEnv(createRecordingDatabase()),
    );

    assert.equal(response.status, 405, resource);
    assert.equal(response.headers.get("allow"), "PATCH, DELETE");
  }
});

test("taxonomy collections list without requiring a body", async () => {
  for (const resource of ["categories", "tags"]) {
    const db = createRecordingDatabase({ all: [{ results: [{ id: 1, name: "n", slug: "s" }] }] });
    const response = await worker.fetch(apiRequest(`/api/${resource}`), createEnv(db));

    assert.equal(response.status, 200, resource);
    assert.deepEqual(await response.json(), { data: { items: [{ id: 1, name: "n", slug: "s" }] } });
  }
});

// ---------------------------------------------------------------- 分類與標籤的名稱唯一性
//
// 代稱重複了使用者看不到（代稱只出現在網址上），名稱重複卻會產生兩個外觀
// 一模一樣的分類，專案被拆到不同分類而沒人看得出來。2026-08-22 的後台實測
// 就是這樣連建出兩個「老師行政用」。以下測試把這個行為釘住。

test("taxonomy create rejects a duplicate name before inserting", async () => {
  for (const resource of ["categories", "tags"]) {
    // 第一次 first() 是名稱檢查——回一筆代表已經有同名的。
    const db = createRecordingDatabase({ first: [{ id: 7 }] });
    const response = await worker.fetch(
      apiRequest(`/api/${resource}`, { method: "POST", body: JSON.stringify({ name: "教學工具" }) }),
      createEnv(db),
    );

    assert.equal(response.status, 409, resource);

    const payload = await response.json();
    assert.equal(payload.error.code, "NAME_CONFLICT", resource);
    // 給使用者看的訊息必須是中文，且要指向「改用既有的」這個正確動作。
    assert.match(payload.error.fields.name, /同名/, resource);

    const inserts = db.calls.filter((call) => call.sql.includes("INSERT"));
    assert.equal(inserts.length, 0, `${resource}：名稱重複時不應寫入`);
  }
});

test("taxonomy name comparison ignores case and surrounding spaces", async () => {
  const db = createRecordingDatabase({ first: [null, null] });
  await worker.fetch(
    apiRequest("/api/tags", { method: "POST", body: JSON.stringify({ name: "  互動  " }) }),
    createEnv(db),
  );

  const nameCheck = db.calls.find((call) => call.sql.includes("LOWER(TRIM(name))"));

  assert.ok(nameCheck, "名稱檢查必須用 LOWER(TRIM(...)) 比對");
  // 驗證層已經先去掉前後空白，所以 bind 進來的是修剪後的值。
  // SQL 裡仍保留 TRIM，是為了比對資料庫既有欄位——舊資料可能沒修剪過。
  assert.deepEqual(nameCheck.params, ["互動"], "使用者輸入要走 bind，不能拼進 SQL");
});

test("taxonomy patch excludes itself from the name conflict check", async () => {
  const db = createRecordingDatabase({ first: [{ id: 3 }] });
  await worker.fetch(
    apiRequest("/api/categories/3", { method: "PATCH", body: JSON.stringify({ name: "教學工具" }) }),
    createEnv(db),
  );

  const nameCheck = db.calls.find((call) => call.sql.includes("LOWER(TRIM(name))"));

  assert.ok(nameCheck, "更新時也要檢查名稱");
  assert.ok(nameCheck.sql.includes("id != ?"), "必須把自己排除，否則改成原名會被自己擋住");
  assert.deepEqual(nameCheck.params, ["教學工具", 3]);
});

test("taxonomy list reports how many projects use each entry", async () => {
  // 後台刪除分類/標籤前要顯示影響範圍，這個數字就是來源。
  const expected = {
    categories: "projects.category_id",
    tags: "project_tags.tag_id",
  };

  for (const resource of ["categories", "tags"]) {
    const db = createRecordingDatabase({ all: [{ results: [] }] });
    await worker.fetch(apiRequest(`/api/${resource}`), createEnv(db));

    const listQuery = db.calls.find((call) => call.op === "all");

    assert.ok(listQuery.sql.includes("project_count"), `${resource}：清單要附上 project_count`);
    assert.ok(listQuery.sql.includes(expected[resource]), `${resource}：使用數要算對關聯欄位`);
  }
});
