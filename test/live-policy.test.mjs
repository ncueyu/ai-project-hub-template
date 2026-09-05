/**
 * 權限即時生效（2026-09-04）。
 *
 * 這一組測試盯的是一個**只有實際操作才會發現**的失敗：使用者在後台把專案
 * 改成公開，卻仍然要重新部署一次才看得到。詳細背景見
 * `src/access-gate/policy-lookup.js` 與 `protected-worker.js` 的檔頭。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword } from "../src/access-gate/password.js";
import { createProtectedWorker } from "../src/access-gate/protected-worker.js";
import {
  DEFAULT_POLICY_TTL_MS,
  clearPolicyCache,
  createPolicyLookup,
} from "../src/access-gate/policy-lookup.js";

const TEST_SECRET = "test-only-signing-key-do-not-use-in-production-0123456789";
const TEST_ITERATIONS = 1000;

function createEnv() {
  return {
    SESSION_SIGNING_KEY: TEST_SECRET,
    ASSETS: {
      async fetch() {
        return new Response("PROTECTED CONTENT");
      },
    },
  };
}

function pageRequest(path = "/") {
  return new Request(`https://project.example.test${path}`, {
    headers: { "Sec-Fetch-Dest": "document" },
  });
}

/**
 * 假的 D1。first() 回傳呼叫端給的那一列，並記錄查詢次數。
 */
function fakeDb(row, options = {}) {
  const state = { queries: 0, boundValues: [], lastSql: "" };

  return {
    state,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              state.queries += 1;
              state.boundValues.push(values);
              state.lastSql = sql;

              if (options.throws) {
                throw new Error("D1 網路錯誤");
              }

              return row;
            },
          };
        },
      };
    },
  };
}

// ───────── 閘道端：即時值優先、烙印值當後援 ─────────

test("沒有 resolvePolicy 時，行為完全等於改動前（用烙印值）", async () => {
  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "private",
    policyVersion: 1,
    secureCookie: false,
  });

  const response = await worker.fetch(pageRequest(), createEnv());

  assert.equal(response.status, 404);
});

test("即時查到 public、烙印是 private → 放行（不用重新部署）", async () => {
  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "private",
    policyVersion: 1,
    secureCookie: false,
    resolvePolicy: async () => ({ visibility: "public", policyVersion: 1, passwordHash: null }),
  });

  const response = await worker.fetch(pageRequest(), createEnv());

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "PROTECTED CONTENT");
});

test("即時查到 private、烙印是 public → 404（收回權限也是即時的）", async () => {
  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "public",
    policyVersion: 1,
    secureCookie: false,
    resolvePolicy: async () => ({ visibility: "private", policyVersion: 1, passwordHash: null }),
  });

  assert.equal((await worker.fetch(pageRequest(), createEnv())).status, 404);
});

test("即時查到 disabled → 404", async () => {
  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "public",
    policyVersion: 1,
    secureCookie: false,
    resolvePolicy: async () => ({ visibility: "disabled", policyVersion: 1, passwordHash: null }),
  });

  assert.equal((await worker.fetch(pageRequest(), createEnv())).status, 404);
});

test("即時查詢回 null（資料庫查不到）→ 回退到烙印值，不是放行", async () => {
  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "private",
    policyVersion: 1,
    secureCookie: false,
    resolvePolicy: async () => null,
  });

  assert.equal((await worker.fetch(pageRequest(), createEnv())).status, 404);
});

test("即時查詢拋錯 → 回退到烙印值，網站不會因此掛掉", async () => {
  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "public",
    policyVersion: 1,
    secureCookie: false,
    resolvePolicy: async () => {
      throw new Error("注入端的實作壞了");
    },
  });

  assert.equal((await worker.fetch(pageRequest(), createEnv())).status, 200);
});

test("一次請求只呼叫 resolvePolicy 一次", async () => {
  let calls = 0;

  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "private",
    policyVersion: 1,
    secureCookie: false,
    resolvePolicy: async () => {
      calls += 1;
      return { visibility: "password", policyVersion: 1, passwordHash: null };
    },
  });

  await worker.fetch(pageRequest(), createEnv());

  assert.equal(calls, 1);
});

test("即時查到的密碼雜湊會被用來驗證登入（烙印值是 null 也能登入）", async () => {
  const hash = await hashPassword("live password", { iterations: TEST_ITERATIONS });

  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "private",
    policyVersion: 1,
    // 烙印時這個專案還沒有密碼——正是「先部署成 private，之後才在後台設密碼」。
    passwordHash: null,
    secureCookie: false,
    resolvePolicy: async () => ({ visibility: "password", policyVersion: 1, passwordHash: hash }),
  });

  const response = await worker.fetch(
    new Request("https://project.example.test/__access/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "live password" }),
    }),
    createEnv(),
  );

  assert.equal(response.status, 303, "應該登入成功並轉址");
});

test("即時查到密碼是 null → 烙印的舊雜湊不會復活", async () => {
  const oldHash = await hashPassword("old password", { iterations: TEST_ITERATIONS });

  const worker = createProtectedWorker({
    projectId: 1,
    visibility: "password",
    policyVersion: 1,
    passwordHash: oldHash,
    secureCookie: false,
    // 使用者在後台把密碼刪掉了，但權限還留在 password。
    resolvePolicy: async () => ({ visibility: "password", policyVersion: 1, passwordHash: null }),
  });

  const response = await worker.fetch(
    new Request("https://project.example.test/__access/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "old password" }),
    }),
    createEnv(),
  );

  assert.equal(response.status, 200, "應該停在密碼頁");
  assert.match(await response.text(), /密碼不正確/);
});

// ───────── 查詢端：D1、快取、失敗處理 ─────────

test("查得到就回傳三個欄位", async () => {
  clearPolicyCache();

  const db = fakeDb({ visibility: "public", policy_version: 3, password_hash: "pbkdf2-sha256$x$y$z" });
  const lookup = createPolicyLookup({ db, projectId: 42 });

  assert.deepEqual(await lookup(), {
    visibility: "public",
    policyVersion: 3,
    passwordHash: "pbkdf2-sha256$x$y$z",
  });
  assert.deepEqual(db.state.boundValues[0], [42], "應該用 projectId 綁定參數");
});

test("沒有 project_policies 那一列時，policyVersion 預設 1、密碼 null", async () => {
  clearPolicyCache();

  const db = fakeDb({ visibility: "public", policy_version: null, password_hash: null });
  const lookup = createPolicyLookup({ db, projectId: 7 });

  assert.deepEqual(await lookup(), { visibility: "public", policyVersion: 1, passwordHash: null });
});

test("查詢用 LEFT JOIN——沒設過密碼的專案也要查得到自己的權限", async () => {
  clearPolicyCache();

  const db = fakeDb({ visibility: "public", policy_version: null, password_hash: null });
  const lookup = createPolicyLookup({ db, projectId: 8 });

  await lookup();

  assert.match(db.state.lastSql, /LEFT JOIN/i);
});

test("TTL 內第二次呼叫用快取，不再查資料庫", async () => {
  clearPolicyCache();

  const db = fakeDb({ visibility: "public", policy_version: 1, password_hash: null });
  let clock = 1_000;
  const lookup = createPolicyLookup({ db, projectId: 101, now: () => clock });

  await lookup();
  clock += DEFAULT_POLICY_TTL_MS - 1;
  await lookup();

  assert.equal(db.state.queries, 1, "一次頁面載入的多個請求應該只查一次");
});

test("TTL 過期後重新查", async () => {
  clearPolicyCache();

  const db = fakeDb({ visibility: "public", policy_version: 1, password_hash: null });
  let clock = 1_000;
  const lookup = createPolicyLookup({ db, projectId: 102, now: () => clock });

  await lookup();
  clock += DEFAULT_POLICY_TTL_MS + 1;
  await lookup();

  assert.equal(db.state.queries, 2);
});

test("沒有 D1 綁定 → 回 null，不拋錯", async () => {
  clearPolicyCache();

  const lookup = createPolicyLookup({ db: undefined, projectId: 103 });

  assert.equal(await lookup(), null);
});

test("查詢拋錯 → 回 null，不拋錯", async () => {
  clearPolicyCache();

  const db = fakeDb(null, { throws: true });
  const lookup = createPolicyLookup({ db, projectId: 104 });

  assert.equal(await lookup(), null);
});

test("查無此專案 → 回 null", async () => {
  clearPolicyCache();

  const db = fakeDb(null);
  const lookup = createPolicyLookup({ db, projectId: 105 });

  assert.equal(await lookup(), null);
});

test("失敗的結果也進快取——壞掉的資料庫不該被自己的重試流量壓垮", async () => {
  clearPolicyCache();

  const db = fakeDb(null, { throws: true });
  let clock = 1_000;
  const lookup = createPolicyLookup({ db, projectId: 106, now: () => clock });

  await lookup();
  clock += 1;
  await lookup();

  assert.equal(db.state.queries, 1);
});

test("不同專案的快取互不影響", async () => {
  clearPolicyCache();

  const dbA = fakeDb({ visibility: "public", policy_version: 1, password_hash: null });
  const dbB = fakeDb({ visibility: "private", policy_version: 1, password_hash: null });

  const a = await createPolicyLookup({ db: dbA, projectId: 201 })();
  const b = await createPolicyLookup({ db: dbB, projectId: 202 })();

  assert.equal(a?.visibility, "public");
  assert.equal(b?.visibility, "private");
});

test("查詢端與閘道端串起來：資料庫說 public，烙印說 private → 放行", async () => {
  clearPolicyCache();

  const db = fakeDb({ visibility: "public", policy_version: 1, password_hash: null });

  const worker = createProtectedWorker({
    projectId: 301,
    visibility: "private",
    policyVersion: 1,
    secureCookie: false,
    resolvePolicy: createPolicyLookup({ db, projectId: 301 }),
  });

  assert.equal((await worker.fetch(pageRequest(), createEnv())).status, 200);
});
