import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { importSigningKey, issueSession } from "../src/access-gate/session.js";
import { ADMIN_PROJECT_ID, ADMIN_POLICY_VERSION } from "../src/admin-gate.js";
import {
  createLink,
  deleteLink,
  getLinkById,
  listLinks,
  listPublicLinks,
  updateLink,
} from "../src/repositories/links.js";

/**
 * 這一份測試涵蓋兩層：
 *   1. `src/repositories/links.js` 直接呼叫——比照 `test/database.test.mjs`／
 *      `test/gallery.test.mjs` 的做法，用一個會記錄查詢的假 D1，不連真的資料庫
 *      （本專案所有測試皆同此慣例，真實 SQL 行為已於本機 D1 實測驗證，見階段一）。
 *   2. `src/routes/links.js` 透過 `worker.fetch`——比照 `test/api-contract.test.mjs`
 *      的登入 session 與跨站防護測試方式。
 */

// ---------------------------------------------------------------------------
// 共用測試工具
// ---------------------------------------------------------------------------

/**
 * 依 SQL 特徵回應的假 D1，與 `test/gallery.test.mjs` 的 `createGalleryDatabase`
 * 同一種設計動機：links 的公開查詢與後台查詢都可能在同一個測試裡出現，
 * 先進先出佇列容易對錯查詢，SQL 特徵比對更穩定。
 *
 * @param {{ links?: any[], categoryExists?: boolean, first?: any[] }} [options]
 */
function createRecordingDatabase({ links = [], categoryExists = true, first = [] } = {}) {
  const calls = [];
  const firstQueue = [...first];

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

        if (sql.includes("FROM categories WHERE id")) {
          return categoryExists ? { id: params[0] } : null;
        }

        if (firstQueue.length > 0) {
          return firstQueue.shift();
        }

        return null;
      },
      async all() {
        calls.push({ sql, params, op: "all" });

        if (sql.includes("FROM links")) {
          return { results: links };
        }

        return { results: [] };
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
  };
}

const TEST_SIGNING_KEY_SECRET = "links-test-signing-key-do-not-use-0123456789";
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

function createEnv(db, { authenticated = true } = {}) {
  return {
    ADMIN_ENABLED: "true",
    SESSION_SIGNING_KEY: TEST_SIGNING_KEY_SECRET,
    ASSETS: { fetch: async () => new Response("STATIC") },
    ...(db ? { DB: db } : {}),
    ...(authenticated ? {} : {}),
  };
}

function apiRequest(path, init = {}, { authenticated = true } = {}) {
  const headers = {
    ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(authenticated ? { Cookie: adminSessionCookie } : {}),
    ...init.headers,
  };

  return new Request(`https://hub.example.test${path}`, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Repository 層：createLink / updateLink / deleteLink
// ---------------------------------------------------------------------------

test("createLink inserts all columns and reads back through RETURNING id", async () => {
  const db = createRecordingDatabase({ first: [{ id: 1 }, { id: 1, name: "測試連結" }] });

  const result = await createLink(
    db,
    { name: "測試連結", url: "https://example.test", description: "備註", icon: "🔗", category_id: 2, sort_order: 3, is_listed: true },
    "2026-08-27T00:00:00Z",
  );

  assert.ok(result);

  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO links"));
  assert.ok(insert, "應該有一次 INSERT");
  assert.deepEqual(insert.params, [2, "測試連結", "https://example.test", "備註", "🔗", 3, 1, "2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z"]);
});

test("createLink defaults is_listed to 1 when omitted, and 0 only when explicitly false", async () => {
  const db = createRecordingDatabase({ first: [{ id: 1 }, { id: 1 }] });

  await createLink(db, { name: "a", url: "http://192.168.1.1", is_listed: false }, "now");

  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO links"));
  assert.equal(insert.params[6], 0, "is_listed: false 必須存成 0");
});

test("updateLink only writes columns present in the payload and bumps updated_at", async () => {
  const db = createRecordingDatabase({ first: [{ id: 5, name: "改名後" }] });

  await updateLink(db, 5, { name: "改名後", is_listed: false }, "2026-08-27T01:00:00Z");

  const update = db.calls.find((call) => call.sql.includes("UPDATE links"));
  assert.ok(update);
  assert.ok(update.sql.includes("name = ?"));
  assert.ok(update.sql.includes("is_listed = ?"));
  assert.ok(update.sql.includes("updated_at = ?"));
  assert.equal(update.sql.includes("url = ?"), false, "沒出現在 payload 的欄位不該被 UPDATE");
  assert.deepEqual(update.params, ["改名後", 0, "2026-08-27T01:00:00Z", 5]);
});

test("deleteLink returns false without deleting when the row does not exist", async () => {
  const db = createRecordingDatabase({ first: [null] });

  const removed = await deleteLink(db, 999);

  assert.equal(removed, false);
  assert.equal(db.calls.some((call) => call.sql.includes("DELETE")), false, "找不到時不應執行刪除");
});

test("getLinkById and listLinks select the full admin column set", async () => {
  const db = createRecordingDatabase({ links: [{ id: 1 }] });

  await listLinks(db);
  await getLinkById(db, 1);

  for (const call of db.calls) {
    assert.ok(call.sql.includes("is_listed"), "後台查詢必須包含 is_listed，管理者要能看到目前狀態");
  }
});

// ---------------------------------------------------------------------------
// Repository 層：listPublicLinks —— 只回 is_listed = 1
// ---------------------------------------------------------------------------

test("listPublicLinks filters on is_listed = 1 and orders by sort_order then name", async () => {
  const db = createRecordingDatabase({ links: [] });

  await listPublicLinks(db);

  const query = db.calls.find((call) => call.sql.includes("FROM links l"));
  assert.ok(query);
  assert.ok(query.sql.includes("WHERE l.is_listed = 1"), "公開查詢必須限制 is_listed = 1");
  assert.ok(query.sql.includes("ORDER BY l.sort_order ASC, l.name ASC"));
});

test("listPublicLinks never outputs the is_listed flag or unpublishable fields", async () => {
  const db = createRecordingDatabase({
    links: [{
      id: 1,
      name: "外部工具",
      url: "https://example.test",
      description: "備註",
      icon: "🔗",
      category_id: 3,
      category_name: "教學工具",
      category_slug: "teaching",
    }],
  });

  const [item] = await listPublicLinks(db);

  assert.deepEqual(Object.keys(item).sort(), [
    "category",
    "description",
    "icon",
    "id",
    "name",
    "url",
  ]);
  assert.equal(item.category.slug, "teaching");
});

test("listPublicLinks serialises a missing category as null", async () => {
  const db = createRecordingDatabase({
    links: [{ id: 1, name: "無分類連結", url: "https://example.test", description: "", icon: "", category_id: null, category_name: null, category_slug: null }],
  });

  const [item] = await listPublicLinks(db);

  assert.equal(item.category, null);
});

// ---------------------------------------------------------------------------
// Route 層：/api/links —— 401、跨站、驗證、CRUD
// ---------------------------------------------------------------------------

test("unauthenticated write to /api/links is rejected with 401", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/links", { method: "POST", body: JSON.stringify({ name: "x", url: "https://example.test" }) }, { authenticated: false }),
    createEnv(db),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "ADMIN_AUTH_REQUIRED");
});

test("unauthenticated read of /api/links is also rejected with 401", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/links", {}, { authenticated: false }),
    createEnv(db),
  );

  assert.equal(response.status, 401);
});

test("cross-site mutations to /api/links are blocked before touching the database", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/links", {
      method: "POST",
      body: JSON.stringify({ name: "x", url: "https://example.test" }),
      headers: { "Sec-Fetch-Site": "cross-site" },
    }),
    createEnv(db),
  );

  assert.equal(response.status, 403);
  assert.equal(db.calls.length, 0);
});

test("a non-http(s) url is rejected with 400 before touching the database", async () => {
  const db = createRecordingDatabase();

  for (const url of ["ftp://example.test", "javascript:alert(1)", "not-a-url", ""]) {
    const response = await worker.fetch(
      apiRequest("/api/links", { method: "POST", body: JSON.stringify({ name: "壞連結", url }) }),
      createEnv(db),
    );

    assert.equal(response.status, 400, url);
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED", url);
  }

  assert.equal(db.calls.length, 0, "驗證失敗不應觸發任何查詢");
});

test("http (not just https) urls are accepted, per the 2026-08-27 decision", async () => {
  const db = createRecordingDatabase({ first: [{ id: 1 }, { id: 1, name: "校內系統" }] });
  const response = await worker.fetch(
    apiRequest("/api/links", {
      method: "POST",
      body: JSON.stringify({ name: "校內系統", url: "http://192.168.1.1/portal" }),
    }),
    createEnv(db),
  );

  assert.equal(response.status, 201);
});

test("creating a link with a non-existent category_id is rejected", async () => {
  const db = createRecordingDatabase({ categoryExists: false });
  const response = await worker.fetch(
    apiRequest("/api/links", {
      method: "POST",
      body: JSON.stringify({ name: "x", url: "https://example.test", category_id: 999 }),
    }),
    createEnv(db),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.fields.category_id !== undefined, true);
});

test("deleting a missing link returns 404", async () => {
  const db = createRecordingDatabase({ first: [null] });
  const response = await worker.fetch(
    apiRequest("/api/links/999", { method: "DELETE" }),
    createEnv(db),
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "LINK_NOT_FOUND");
});

test("unsupported methods on the links collection return 405 with Allow", async () => {
  const response = await worker.fetch(
    apiRequest("/api/links", { method: "PUT", body: "{}" }),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, POST");
});
