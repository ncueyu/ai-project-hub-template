import assert from "node:assert/strict";
import test from "node:test";

import { getDatabase, jsonError, requireDatabase } from "../src/http.js";

function createDatabaseBinding() {
  return {
    prepare() {
      return {
        bind() {
          return { all: async () => ({ results: [] }) };
        },
        all: async () => ({ results: [] }),
      };
    },
  };
}

test("getDatabase returns the binding when D1 is configured", () => {
  const db = createDatabaseBinding();

  assert.equal(getDatabase({ ASSETS: { fetch: async () => new Response("") }, DB: db }), db);
});

test("getDatabase returns null when the D1 binding is missing", () => {
  assert.equal(getDatabase({ ASSETS: { fetch: async () => new Response("") } }), null);
});

test("getDatabase rejects a binding that cannot prepare statements", () => {
  // 保護情境：wrangler.jsonc 綁定了名稱，但注入的物件不是 D1Database。
  const notADatabase = { prepare: "not-a-function" };

  assert.equal(
    getDatabase({ ASSETS: { fetch: async () => new Response("") }, DB: notADatabase }),
    null,
  );
});

test("requireDatabase surfaces a 503 contract instead of throwing", async () => {
  const result = requireDatabase({ ASSETS: { fetch: async () => new Response("") } });

  assert.equal(result.db, null);
  assert.ok(result.response instanceof Response);
  assert.equal(result.response.status, 503);
  assert.equal(
    result.response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(await result.response.json(), {
    error: {
      code: "DATABASE_NOT_CONFIGURED",
      message: "Hub D1 binding is not configured for this environment.",
    },
  });
});

test("requireDatabase passes the binding through when configured", () => {
  const db = createDatabaseBinding();
  const result = requireDatabase({ ASSETS: { fetch: async () => new Response("") }, DB: db });

  assert.equal(result.db, db);
  assert.equal("response" in result, false);
});

test("jsonError never caches and always returns the error envelope", async () => {
  const response = jsonError(404, "NOT_FOUND", "Project not found.");

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: { code: "NOT_FOUND", message: "Project not found." },
  });
});
