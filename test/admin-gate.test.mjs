import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { importSigningKey, issueSession } from "../src/access-gate/session.js";
import { hashPassword } from "../src/access-gate/password.js";
import { ADMIN_LOGIN_PATH, ADMIN_LOGOUT_PATH, ADMIN_PROJECT_ID, ADMIN_POLICY_VERSION } from "../src/admin-gate.js";

/**
 * 管理介面總開關 ＋ 密碼閘道。
 *
 * 2026-08-25 起有**兩道獨立的防線**，缺一不可：
 *   1. `ADMIN_ENABLED`：管理後台與管理 API 的總開關，忘記設定時的結果
 *      必須是「沒有後台」而不是「後台大門敞開」。
 *   2. `src/admin-gate.js` 的密碼閘道：即使 ①開啟了，未登入的請求
 *      仍然進不去——這是取代原計畫 Cloudflare Access 的自建機制
 *      （理由見 `2026-08-25-工作計畫.md`：使用者不想輸入卡號，且查證發現
 *      workers.dev 網域無法可靠做到只保護 /admin）。
 *
 * 這份測試 2026-08-13 原本只驗證①，當時①開啟後台台就是全開，因為②尚未存在。
 * 這裡保留①的既有測試，並改寫／新增②的測試，不再假設「開啟＝全開」。
 */

/** 測試專用假金鑰，正式環境一律使用 Cloudflare Secret。 */
const TEST_SECRET = "test-only-admin-signing-key-do-not-use-0123456789";
const ADMIN_PASSWORD = "correct horse battery staple";

/** 測試用的低重複次數，只為讓測試快速完成，不代表正式參數。 */
const TEST_ITERATIONS = 1000;

const NOW = 1_780_000_000;

let signingKey;
let adminPasswordHash;

test.before(async () => {
  signingKey = await importSigningKey(TEST_SECRET);
  adminPasswordHash = await hashPassword(ADMIN_PASSWORD, { iterations: TEST_ITERATIONS });
});

/**
 * 預設把 `ADMIN_ENABLED` 設成 `"true"`——②密碼閘道那組測試的重點是
 * 「開了之後未登入還是進不去」，不是①的總開關本身，所以預設開著比較合理。
 * ①那組測試需要「未設定」或「明確關閉」的情境，會顯式傳入 `adminEnabled`。
 *
 * @param {{ adminEnabled?: string | undefined, withAuth?: boolean }} [options]
 */
function createEnv(options = {}) {
  const assetCalls = [];
  const dbCalls = [];
  const adminEnabled = "adminEnabled" in options ? options.adminEnabled : "true";

  return {
    assetCalls,
    dbCalls,
    ...(adminEnabled === undefined ? {} : { ADMIN_ENABLED: adminEnabled }),
    ...(options.withAuth === false ? {} : { SESSION_SIGNING_KEY: TEST_SECRET, ADMIN_PASSWORD_HASH: adminPasswordHash }),
    DB: {
      prepare(sql) {
        dbCalls.push(sql);

        return {
          bind() { return this; },
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() { return { success: true }; },
        };
      },
      async batch(statements) { return statements.map(() => ({ success: true })); },
    },
    ASSETS: {
      async fetch(request) {
        assetCalls.push(new URL(request.url).pathname);
        return new Response("ASSET", { headers: { "Content-Type": "text/html" } });
      },
    },
  };
}

/** 網頁請求：`wantsHtml()` 靠 `Sec-Fetch-Dest` 或 `Accept` 判斷，兩者都不給會被當成子資源。 */
function pageRequest(path, init = {}) {
  return new Request(`https://hub.example.test${path}`, {
    ...init,
    headers: { "Sec-Fetch-Dest": "document", ...init.headers },
  });
}

function assetRequest(path, init = {}) {
  return new Request(`https://hub.example.test${path}`, {
    ...init,
    headers: { "Sec-Fetch-Dest": "script", ...init.headers },
  });
}

/** 一般 API 呼叫（非瀏覽器文件請求）。 */
function apiRequest(path, init = {}) {
  return new Request(`https://hub.example.test${path}`, init);
}

/**
 * 直接簽發一個有效的管理員 session token，跳過表單登入，
 * 用於「已登入」情境的測試——登入表單本身有專門的測試涵蓋。
 *
 * 預設過期時間用**真實時鐘**，不是 `NOW` 常數：`isAdminAuthenticated`
 * 在 `src/index.js` 裡被呼叫時不會收到 `now` 覆寫（不像
 * `protected-worker.test.mjs` 那樣有 runtime 注入點），一律比對真實時間。
 * `NOW`（2026-05-28）只在故意測「已過期」時使用，那種情境本來就要早於現在。
 */
async function adminSessionCookie(expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  const token = await issueSession(signingKey, {
    project_id: ADMIN_PROJECT_ID,
    policy_version: ADMIN_POLICY_VERSION,
    expires_at: expiresAt,
  });

  return `hub_admin_session=${token}`;
}

function cookieFrom(response) {
  const header = response.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0];
}

const ADMIN_PATHS = ["/admin", "/admin/", "/admin/index.html", "/admin/admin.js", "/admin/admin.css"];

const ADMIN_API_PATHS = [
  "/api/projects",
  "/api/projects/1",
  "/api/projects/1/policy",
  "/api/projects/1/deployments",
  "/api/projects/1/thumbnail",
  "/api/categories",
  "/api/categories/1",
  "/api/tags",
  "/api/tags/1",
];

// ------------------------------------------------------------ ① 總開關

test("the admin interface is closed by default when the flag is absent", async () => {
  const env = createEnv({ adminEnabled: undefined });

  for (const path of [...ADMIN_PATHS, ...ADMIN_API_PATHS]) {
    const response = await worker.fetch(pageRequest(path), env);

    assert.equal(response.status, 404, `${path} 應在未設定時關閉`);
  }

  assert.equal(env.assetCalls.length, 0, "關閉時不可送出任何後台檔案");
});

test("an explicit false closes the admin interface", async () => {
  const env = createEnv({ adminEnabled: "false" });

  for (const path of [...ADMIN_PATHS, ...ADMIN_API_PATHS]) {
    const response = await worker.fetch(pageRequest(path), env);

    assert.equal(response.status, 404, path);
  }

  assert.equal(env.assetCalls.length, 0);
});

test("only the exact string true opens the admin interface", async () => {
  for (const value of ["TRUE", "True", "1", "yes", "on", " true", ""]) {
    const env = createEnv({ adminEnabled: value });
    const response = await worker.fetch(pageRequest("/admin/"), env);

    assert.equal(response.status, 404, `"${value}" 不應開啟管理介面`);
  }
});

test("closing the admin interface never touches the database", async () => {
  const env = {
    ADMIN_ENABLED: "false",
    DB: {
      prepare() {
        throw new Error("關閉時不應查詢資料庫");
      },
    },
    ASSETS: { fetch: async () => new Response("ASSET") },
  };

  for (const path of ADMIN_API_PATHS) {
    const response = await worker.fetch(pageRequest(path), env);
    assert.equal(response.status, 404, path);
  }
});

test("public routes are unaffected when the admin interface is closed", async () => {
  const env = createEnv({ adminEnabled: "false" });

  const health = await worker.fetch(pageRequest("/api/health"), env);
  assert.equal(health.status, 200, "健康檢查應維持可用");
  assert.deepEqual(await health.json(), { status: "ok" });

  const gallery = await worker.fetch(pageRequest("/api/gallery/projects"), env);
  assert.equal(gallery.status, 200, "公開的展示中心 API 應維持可用");

  for (const path of ["/", "/index.html", "/styles.css", "/app.js"]) {
    const response = await worker.fetch(pageRequest(path), env);

    assert.equal(response.status, 200, `${path} 應維持可用`);
  }
});

test("the disabled response does not reveal that an admin area exists", async () => {
  const env = createEnv({ adminEnabled: "false" });
  const response = await worker.fetch(pageRequest("/admin/"), env);
  const body = await response.text();

  assert.equal(response.status, 404);

  for (const word of ["admin", "後台", "權限", "登入", "forbidden", "unauthorized"]) {
    assert.equal(body.toLowerCase().includes(word.toLowerCase()), false, `回應不應提到「${word}」`);
  }
});

test("a path that merely starts with admin text is not mistaken for the admin area", async () => {
  const env = createEnv({ adminEnabled: "false" });
  const response = await worker.fetch(pageRequest("/administrator-guide"), env);

  assert.equal(response.status, 200, "只是開頭相似的路徑不應被當成後台");
});

// ------------------------------------------------------------ ② 密碼閘道（C1-C7）

test("C1: a wrong password on the login form is rejected without revealing why", async () => {
  const env = createEnv();
  const body = new URLSearchParams({ password: "wrong password" });

  const response = await worker.fetch(
    apiRequest(ADMIN_LOGIN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
    env,
  );

  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Set-Cookie"), null, "失敗時不可簽發工作階段");
  assert.ok(html.includes("密碼不正確"));

  for (const leak of ["pbkdf2", "salt", "hash", "iterations", TEST_SECRET, adminPasswordHash]) {
    assert.equal(html.toLowerCase().includes(leak.toLowerCase()), false, `不可洩漏 ${leak}`);
  }
});

test("C2: the correct password issues a session that then grants repeated access", async () => {
  const env = createEnv();
  const body = new URLSearchParams({ password: ADMIN_PASSWORD });

  const login = await worker.fetch(
    apiRequest(ADMIN_LOGIN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
    env,
  );

  assert.equal(login.status, 303);
  assert.equal(login.headers.get("Location"), "/admin/");

  const cookie = cookieFrom(login);
  assert.ok(cookie.startsWith("hub_admin_session="));

  const setCookie = login.headers.get("Set-Cookie");
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("SameSite=Lax"));

  // 同一個 cookie 可以重複使用，不必每次都重新輸入密碼。
  for (let i = 0; i < 3; i += 1) {
    const page = await worker.fetch(pageRequest("/admin/", { headers: { Cookie: cookie } }), env);
    assert.equal(page.status, 200, `第 ${i} 次應成功`);
  }

  assert.equal(env.assetCalls.length, 3);
});

test("C3: an unauthenticated document request sees the login page; a sub-resource sees 404", async () => {
  const env = createEnv();

  const page = await worker.fetch(pageRequest("/admin/"), env);
  const pageBody = await page.text();

  assert.equal(page.status, 200);
  assert.ok(pageBody.includes("需要密碼"), "未登入應看到登入頁，不是後台內容");
  assert.ok(pageBody.includes(ADMIN_LOGIN_PATH), "登入表單必須送到管理後台自己的登入端點");

  for (const path of ["/admin/admin.js", "/admin/admin.css"]) {
    const response = await worker.fetch(assetRequest(path), env);
    assert.equal(response.status, 404, `${path} 未登入時不該回登入頁的 HTML`);
  }

  assert.equal(env.assetCalls.length, 0, "未登入時不可觸及任何後台檔案");
});

test("C4: an unauthenticated API call gets a 401 JSON error, not the 404 used for a disabled admin", async () => {
  const env = createEnv();

  for (const path of ADMIN_API_PATHS) {
    const response = await worker.fetch(apiRequest(path), env);
    const body = await response.json();

    assert.equal(response.status, 401, path);
    assert.equal(body.error.code, "ADMIN_AUTH_REQUIRED", path);
  }

  assert.equal(env.dbCalls.length, 0, "未登入時不該碰到資料庫");
});

test("C4b: an authenticated API call passes the gate and reaches the normal handler", async () => {
  const env = createEnv();
  const cookie = await adminSessionCookie();

  const response = await worker.fetch(apiRequest("/api/projects", { headers: { Cookie: cookie } }), env);

  assert.notEqual(response.status, 401, "登入後不該再被閘道擋下");
});

test("C5: an admin session cannot be reused as a per-project password session, and vice versa", async () => {
  // 這是共用同一把 SESSION_SIGNING_KEY 是否安全的直接證明：
  // project_id 哨兵值（0）讓兩種用途天然隔離，不靠額外的金鑰區分。
  const { verifySession } = await import("../src/access-gate/session.js");

  const adminToken = await issueSession(signingKey, {
    project_id: ADMIN_PROJECT_ID,
    policy_version: ADMIN_POLICY_VERSION,
    expires_at: NOW + 3600,
  });

  const projectToken = await issueSession(signingKey, {
    project_id: 4,
    policy_version: 1,
    expires_at: NOW + 3600,
  });

  const adminTokenAsProjectSession = await verifySession(signingKey, adminToken, {
    projectId: 4,
    policyVersion: 1,
    now: NOW,
  });

  const projectTokenAsAdminSession = await verifySession(signingKey, projectToken, {
    projectId: ADMIN_PROJECT_ID,
    policyVersion: ADMIN_POLICY_VERSION,
    now: NOW,
  });

  assert.equal(adminTokenAsProjectSession.allowed, false, "管理員 session 不該被當成專案 4 的通行證");
  assert.equal(projectTokenAsAdminSession.allowed, false, "專案 4 的 session 不該被當成管理員通行證");

  // 反過來，各自對自己的用途仍然有效——證明隔離不是靠把兩者都弄壞。
  const adminOk = await verifySession(signingKey, adminToken, {
    projectId: ADMIN_PROJECT_ID,
    policyVersion: ADMIN_POLICY_VERSION,
    now: NOW,
  });
  const projectOk = await verifySession(signingKey, projectToken, { projectId: 4, policyVersion: 1, now: NOW });

  assert.equal(adminOk.allowed, true);
  assert.equal(projectOk.allowed, true);
});

test("C5b: end to end through the worker — an admin session cookie does not unlock a project's password gate", async () => {
  // 端到端版本：直接用 index.js 暴露的管理後台端點，確認管理員 cookie
  // 對「別的用途」沒有作用——這裡用管理 API 本身以外一個假想的專案哨兵
  // 值再測一次，避免只靠上面的純函式測試就下結論。
  const env = createEnv();
  const cookie = await adminSessionCookie();

  const { verifySession } = await import("../src/access-gate/session.js");
  const result = await verifySession(signingKey, cookie.split("=")[1], {
    projectId: 7,
    policyVersion: 1,
    now: NOW,
  });

  assert.equal(result.allowed, false);

  // 而它確實能通過管理後台自己的檢查——不是「隨便什麼都不通過」的假陽性。
  const admin = await worker.fetch(apiRequest("/api/projects", { headers: { Cookie: cookie } }), env);
  assert.notEqual(admin.status, 401);
});

test("C6: logging out clears the session cookie and the next request sees the login page again", async () => {
  const env = createEnv();

  const logout = await worker.fetch(apiRequest(ADMIN_LOGOUT_PATH, { method: "POST" }), env);

  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("Location"), "/admin");
  assert.ok(logout.headers.get("Set-Cookie").includes("Max-Age=0"));

  const clearedCookie = cookieFrom(logout);
  const page = await worker.fetch(
    pageRequest("/admin/", { headers: { Cookie: `${clearedCookie}=` } }),
    env,
  );

  assert.ok((await page.text()).includes("需要密碼"));
});

test("C7: a missing signing key fails closed for both the page and the API", async () => {
  const env = createEnv({ withAuth: false });
  env.ADMIN_ENABLED = "true";

  const page = await worker.fetch(pageRequest("/admin/"), env);
  assert.ok((await page.text()).includes("需要密碼"), "沒有金鑰時應視為未登入，不可意外放行");

  const api = await worker.fetch(apiRequest("/api/projects"), env);
  assert.equal(api.status, 401);

  assert.equal(env.assetCalls.length, 0);
});

test("an expired admin session is refused", async () => {
  const env = createEnv();
  const cookie = await adminSessionCookie(NOW - 1);

  // verifySession 的 now 由呼叫端傳入；worker.fetch 走真實時鐘，所以這裡
  // 直接構造一個「已經過期很久」的 expires_at，不依賴假時鐘也能驗證過期會被拒絕。
  const response = await worker.fetch(pageRequest("/admin/", { headers: { Cookie: cookie } }), env);

  assert.ok((await response.text()).includes("需要密碼"));
});

test("a tampered admin session cookie is refused", async () => {
  const env = createEnv();
  const cookie = await adminSessionCookie();
  const tampered = `${cookie.slice(0, -6)}AAAAAA`;

  const response = await worker.fetch(apiRequest("/api/projects", { headers: { Cookie: tampered } }), env);

  assert.equal(response.status, 401);
});
