import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { importSigningKey, issueSession } from "../src/access-gate/session.js";
import { ADMIN_PROJECT_ID, ADMIN_POLICY_VERSION } from "../src/admin-gate.js";
import {
  DEFAULT_GALLERY_LAYOUT,
  DEFAULT_SITE_NAME,
  DEFAULT_SITE_LOGO,
  DEFAULT_SITE_THEME,
  SITE_THEME_KEY,
  GALLERY_LAYOUT_KEY,
  GALLERY_LAYOUTS,
  getGalleryLayout,
  getSiteName,
  getSiteLogo,
  isValidGalleryLayout,
  isValidSiteName,
  isValidSiteLogo,
  setGalleryLayout,
  setSiteName,
  setSiteLogo,
  SITE_NAME_KEY,
  SITE_NAME_MAX_LENGTH,
  SITE_LOGO_KEY,
  SITE_LOGOS,
} from "../src/repositories/settings.js";

/** 依 SQL 特徵回應的假 D1，與本專案其他測試同一種寫法。 */
function createRecordingDatabase({ storedRow = null } = {}) {
  const calls = [];

  return {
    calls,
    prepare(sql) {
      let params = [];

      return {
        sql,
        bind(...args) {
          params = args;
          return this;
        },
        async first() {
          calls.push({ sql, params, op: "first" });
          return storedRow;
        },
        async run() {
          calls.push({ sql, params, op: "run" });
          return { success: true };
        },
      };
    },
  };
}

test("GALLERY_LAYOUTS is the single source of truth with four fixed values", () => {
  assert.deepEqual(GALLERY_LAYOUTS, ["hero", "grid", "list", "rows"]);
});

test("isValidGalleryLayout accepts only the four documented values", () => {
  for (const layout of GALLERY_LAYOUTS) {
    assert.equal(isValidGalleryLayout(layout), true, layout);
  }

  for (const invalid of ["", "Grid", "card", "hero ", null, undefined, 1]) {
    assert.equal(isValidGalleryLayout(invalid), false, String(invalid));
  }
});

test("getGalleryLayout returns the default when the table is empty", async () => {
  const db = createRecordingDatabase({ storedRow: null });

  const layout = await getGalleryLayout(db);

  assert.equal(layout, DEFAULT_GALLERY_LAYOUT);
});

test("getGalleryLayout returns the default when the stored value is somehow invalid", async () => {
  // 正常流程不會寫入非法值（setGalleryLayout 會擋），但防禦式地假設資料被
  // 外部工具直接改過——讀取仍必須回預設值，不拋錯。
  const db = createRecordingDatabase({ storedRow: { value: "not-a-real-layout" } });

  const layout = await getGalleryLayout(db);

  assert.equal(layout, DEFAULT_GALLERY_LAYOUT);
});

test("getGalleryLayout returns the stored value when it is valid", async () => {
  const db = createRecordingDatabase({ storedRow: { value: "list" } });

  const layout = await getGalleryLayout(db);

  assert.equal(layout, "list");

  const query = db.calls[0];
  assert.equal(query.params[0], GALLERY_LAYOUT_KEY);
});

test("setGalleryLayout rejects an invalid value without touching the database", async () => {
  const db = createRecordingDatabase();

  const result = await setGalleryLayout(db, "card", "2026-08-27T00:00:00Z");

  assert.equal(result, null);
  assert.equal(db.calls.length, 0);
});

test("setGalleryLayout upserts the key with the given value", async () => {
  const db = createRecordingDatabase();

  const result = await setGalleryLayout(db, "hero", "2026-08-27T00:00:00Z");

  assert.deepEqual(result, { key: GALLERY_LAYOUT_KEY, value: "hero", updated_at: "2026-08-27T00:00:00Z" });

  const upsert = db.calls.find((call) => call.sql.includes("INSERT INTO site_settings"));
  assert.ok(upsert);
  assert.ok(upsert.sql.includes("ON CONFLICT(key)"));
  assert.deepEqual(upsert.params, [GALLERY_LAYOUT_KEY, "hero", "2026-08-27T00:00:00Z"]);
});

// ---------------------------------------------------------------- site_name（2026-08-28 新增，見同日工作計畫 Part A）

test("DEFAULT_SITE_NAME is the neutral placeholder, not the author's name", () => {
  assert.equal(DEFAULT_SITE_NAME, "專案展示中心");
});

test("isValidSiteName rejects empty and overlong values, accepts normal ones", () => {
  assert.equal(isValidSiteName("李老師的AI展示中心"), true);
  assert.equal(isValidSiteName(""), false);
  assert.equal(isValidSiteName("   "), false, "全空白視同空字串");
  assert.equal(isValidSiteName("a".repeat(SITE_NAME_MAX_LENGTH)), true);
  assert.equal(isValidSiteName("a".repeat(SITE_NAME_MAX_LENGTH + 1)), false);
  assert.equal(isValidSiteName(null), false);
  assert.equal(isValidSiteName(undefined), false);
  assert.equal(isValidSiteName(123), false);
});

test("getSiteName returns the neutral default when the table is empty", async () => {
  const db = createRecordingDatabase({ storedRow: null });

  assert.equal(await getSiteName(db), DEFAULT_SITE_NAME);
});

test("getSiteName returns the neutral default when the stored value is somehow invalid", async () => {
  const db = createRecordingDatabase({ storedRow: { value: "" } });

  assert.equal(await getSiteName(db), DEFAULT_SITE_NAME);
});

test("getSiteName returns the stored value when it is valid", async () => {
  const db = createRecordingDatabase({ storedRow: { value: "李老師的AI展示中心" } });

  const name = await getSiteName(db);

  assert.equal(name, "李老師的AI展示中心");

  const query = db.calls[0];
  assert.equal(query.params[0], SITE_NAME_KEY);
});

test("setSiteName rejects an empty value without touching the database", async () => {
  const db = createRecordingDatabase();

  const result = await setSiteName(db, "   ", "2026-08-28T00:00:00Z");

  assert.equal(result, null);
  assert.equal(db.calls.length, 0);
});

test("setSiteName rejects an overlong value without touching the database", async () => {
  const db = createRecordingDatabase();

  const result = await setSiteName(db, "a".repeat(SITE_NAME_MAX_LENGTH + 1), "2026-08-28T00:00:00Z");

  assert.equal(result, null);
  assert.equal(db.calls.length, 0);
});

test("setSiteName upserts the trimmed value", async () => {
  const db = createRecordingDatabase();

  const result = await setSiteName(db, "  李老師的AI展示中心  ", "2026-08-28T00:00:00Z");

  assert.deepEqual(result, { key: SITE_NAME_KEY, value: "李老師的AI展示中心", updated_at: "2026-08-28T00:00:00Z" });

  const upsert = db.calls.find((call) => call.sql.includes("INSERT INTO site_settings"));
  assert.ok(upsert);
  assert.ok(upsert.sql.includes("ON CONFLICT(key)"));
  assert.deepEqual(upsert.params, [SITE_NAME_KEY, "李老師的AI展示中心", "2026-08-28T00:00:00Z"]);
});

// ---------------------------------------------------------------- site_logo（2026-08-28 新增，見 2026-08-28-工作計畫-主畫面改造.md Part A）

test("SITE_LOGOS is the single source of truth with four fixed values", () => {
  assert.deepEqual(SITE_LOGOS, ["logo-01", "logo-02", "logo-03", "logo-04"]);
});

test("DEFAULT_SITE_LOGO is the first of the four logos", () => {
  assert.equal(DEFAULT_SITE_LOGO, "logo-01");
});

test("isValidSiteLogo accepts only the four documented values", () => {
  for (const logo of SITE_LOGOS) {
    assert.equal(isValidSiteLogo(logo), true, logo);
  }

  for (const invalid of ["", "logo-05", "Logo-01", "logo-01 ", null, undefined, 1]) {
    assert.equal(isValidSiteLogo(invalid), false, String(invalid));
  }
});

test("getSiteLogo returns the default when the table is empty", async () => {
  const db = createRecordingDatabase({ storedRow: null });

  assert.equal(await getSiteLogo(db), DEFAULT_SITE_LOGO);
});

test("getSiteLogo returns the default when the stored value is somehow invalid", async () => {
  const db = createRecordingDatabase({ storedRow: { value: "not-a-real-logo" } });

  assert.equal(await getSiteLogo(db), DEFAULT_SITE_LOGO);
});

test("getSiteLogo returns the stored value when it is valid", async () => {
  const db = createRecordingDatabase({ storedRow: { value: "logo-03" } });

  const logo = await getSiteLogo(db);

  assert.equal(logo, "logo-03");

  const query = db.calls[0];
  assert.equal(query.params[0], SITE_LOGO_KEY);
});

test("setSiteLogo rejects an invalid value without touching the database", async () => {
  const db = createRecordingDatabase();

  const result = await setSiteLogo(db, "logo-05", "2026-08-28T00:00:00Z");

  assert.equal(result, null);
  assert.equal(db.calls.length, 0);
});

test("setSiteLogo upserts the key with the given value", async () => {
  const db = createRecordingDatabase();

  const result = await setSiteLogo(db, "logo-02", "2026-08-28T00:00:00Z");

  assert.deepEqual(result, { key: SITE_LOGO_KEY, value: "logo-02", updated_at: "2026-08-28T00:00:00Z" });

  const upsert = db.calls.find((call) => call.sql.includes("INSERT INTO site_settings"));
  assert.ok(upsert);
  assert.ok(upsert.sql.includes("ON CONFLICT(key)"));
  assert.deepEqual(upsert.params, [SITE_LOGO_KEY, "logo-02", "2026-08-28T00:00:00Z"]);
});

// ---------------------------------------------------------------- Route 層：/api/settings/gallery_layout
//
// 前端階段 8（後台版面選擇介面）需要一個寫入端點，階段 1-4 只做到公開讀取，
// 這裡補上管理用的讀寫路由。與 links/projects 同慣例：401、跨站防護、驗證。

const TEST_SIGNING_KEY_SECRET = "settings-test-signing-key-do-not-use-0123456789";
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

test("unauthenticated write to /api/settings/gallery_layout is rejected with 401", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/gallery_layout", { method: "PATCH", body: JSON.stringify({ value: "list" }) }, { authenticated: false }),
    createEnv(db),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "ADMIN_AUTH_REQUIRED");
});

test("cross-site writes to /api/settings/gallery_layout are blocked before touching the database", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/gallery_layout", {
      method: "PATCH",
      body: JSON.stringify({ value: "list" }),
      headers: { "Sec-Fetch-Site": "cross-site" },
    }),
    createEnv(db),
  );

  assert.equal(response.status, 403);
  assert.equal(db.calls.length, 0);
});

test("PATCH /api/settings/gallery_layout rejects an invalid value with 400", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/gallery_layout", { method: "PATCH", body: JSON.stringify({ value: "card" }) }),
    createEnv(db),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  assert.equal(db.calls.length, 0, "驗證失敗不應觸發任何查詢");
});

test("PATCH /api/settings/gallery_layout accepts a valid value and persists it", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/gallery_layout", { method: "PATCH", body: JSON.stringify({ value: "list" }) }),
    createEnv(db),
  );

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.data.value, "list");

  const upsert = db.calls.find((call) => call.sql.includes("INSERT INTO site_settings"));
  assert.ok(upsert, "應該有一次寫入 site_settings");
});

test("GET /api/settings/gallery_layout requires authentication too", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/gallery_layout", {}, { authenticated: false }),
    createEnv(db),
  );

  assert.equal(response.status, 401);
});

test("GET /api/settings/gallery_layout returns the current value once authenticated", async () => {
  const db = createRecordingDatabase({ storedRow: { value: "hero" } });
  const response = await worker.fetch(apiRequest("/api/settings/gallery_layout"), createEnv(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { key: "gallery_layout", value: "hero" } });
});

test("unknown settings sub-paths return 404", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(apiRequest("/api/settings/unknown"), createEnv(db));

  assert.equal(response.status, 404);
});

test("unsupported methods on /api/settings/gallery_layout return 405 with Allow", async () => {
  const response = await worker.fetch(
    apiRequest("/api/settings/gallery_layout", { method: "DELETE" }),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, PATCH");
});

// ---------------------------------------------------------------- Route 層：/api/settings/site_name
//
// 與 gallery_layout 同一套保護（401、跨站防護、驗證），驗收條件見
// 2026-08-27-工作計畫-站名與hub-init.md 階段 A1：未設定時回中性預設值、
// 未登入不能寫入（401）、超長站名被拒（400）、空字串被拒。

test("unauthenticated write to /api/settings/site_name is rejected with 401", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_name", { method: "PATCH", body: JSON.stringify({ value: "李老師的AI展示中心" }) }, { authenticated: false }),
    createEnv(db),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "ADMIN_AUTH_REQUIRED");
  assert.equal(db.calls.length, 0);
});

test("cross-site writes to /api/settings/site_name are blocked before touching the database", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_name", {
      method: "PATCH",
      body: JSON.stringify({ value: "李老師的AI展示中心" }),
      headers: { "Sec-Fetch-Site": "cross-site" },
    }),
    createEnv(db),
  );

  assert.equal(response.status, 403);
  assert.equal(db.calls.length, 0);
});

test("PATCH /api/settings/site_name rejects an empty value with 400", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_name", { method: "PATCH", body: JSON.stringify({ value: "" }) }),
    createEnv(db),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  assert.equal(db.calls.length, 0, "驗證失敗不應觸發任何查詢");
});

test("PATCH /api/settings/site_name rejects an overlong value with 400", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_name", {
      method: "PATCH",
      body: JSON.stringify({ value: "a".repeat(SITE_NAME_MAX_LENGTH + 1) }),
    }),
    createEnv(db),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  assert.equal(db.calls.length, 0);
});

test("PATCH /api/settings/site_name accepts a valid value and persists it", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_name", { method: "PATCH", body: JSON.stringify({ value: "李老師的AI展示中心" }) }),
    createEnv(db),
  );

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.data.value, "李老師的AI展示中心");

  const upsert = db.calls.find((call) => call.sql.includes("INSERT INTO site_settings"));
  assert.ok(upsert, "應該有一次寫入 site_settings");
});

test("GET /api/settings/site_name requires authentication too", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_name", {}, { authenticated: false }),
    createEnv(db),
  );

  assert.equal(response.status, 401);
});

test("GET /api/settings/site_name returns the neutral default when unset", async () => {
  const db = createRecordingDatabase({ storedRow: null });
  const response = await worker.fetch(apiRequest("/api/settings/site_name"), createEnv(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { key: SITE_NAME_KEY, value: DEFAULT_SITE_NAME } });
});

test("unsupported methods on /api/settings/site_name return 405 with Allow", async () => {
  const response = await worker.fetch(
    apiRequest("/api/settings/site_name", { method: "DELETE" }),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, PATCH");
});

// ---------------------------------------------------------------- Route 層：/api/settings/site_logo
//
// 與 gallery_layout／site_name 同一套保護（401、跨站防護、驗證）。

test("unauthenticated write to /api/settings/site_logo is rejected with 401", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_logo", { method: "PATCH", body: JSON.stringify({ value: "logo-02" }) }, { authenticated: false }),
    createEnv(db),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "ADMIN_AUTH_REQUIRED");
  assert.equal(db.calls.length, 0);
});

test("cross-site writes to /api/settings/site_logo are blocked before touching the database", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_logo", {
      method: "PATCH",
      body: JSON.stringify({ value: "logo-02" }),
      headers: { "Sec-Fetch-Site": "cross-site" },
    }),
    createEnv(db),
  );

  assert.equal(response.status, 403);
  assert.equal(db.calls.length, 0);
});

test("PATCH /api/settings/site_logo rejects an invalid value with 400", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_logo", { method: "PATCH", body: JSON.stringify({ value: "logo-05" }) }),
    createEnv(db),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  assert.equal(db.calls.length, 0, "驗證失敗不應觸發任何查詢");
});

test("PATCH /api/settings/site_logo accepts a valid value and persists it", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_logo", { method: "PATCH", body: JSON.stringify({ value: "logo-03" }) }),
    createEnv(db),
  );

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.data.value, "logo-03");

  const upsert = db.calls.find((call) => call.sql.includes("INSERT INTO site_settings"));
  assert.ok(upsert, "應該有一次寫入 site_settings");
});

test("GET /api/settings/site_logo requires authentication too", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_logo", {}, { authenticated: false }),
    createEnv(db),
  );

  assert.equal(response.status, 401);
});

test("GET /api/settings/site_logo returns the default when unset", async () => {
  const db = createRecordingDatabase({ storedRow: null });
  const response = await worker.fetch(apiRequest("/api/settings/site_logo"), createEnv(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { key: SITE_LOGO_KEY, value: DEFAULT_SITE_LOGO } });
});

test("unsupported methods on /api/settings/site_logo return 405 with Allow", async () => {
  const response = await worker.fetch(
    apiRequest("/api/settings/site_logo", { method: "DELETE" }),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, PATCH");
});

// ---------------------------------------------------------------- site_theme（2026-08-29 新增）
//
// 與 site_logo 同一套模式。這裡最重要的一條是「預設值是 zero」——那個裁定
// 的用意是既有站台不會因為改版就被換掉外觀，預設值被改掉會讓所有人的網站
// 在下一次載入時變臉，而且不會有任何錯誤訊息。

test("site_theme 的預設值是 zero，讀不到設定時不換掉任何人的外觀", async () => {
  const db = createRecordingDatabase({ storedRow: null });
  const response = await worker.fetch(apiRequest("/api/settings/site_theme"), createEnv(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { key: SITE_THEME_KEY, value: "zero" } });
  assert.equal(DEFAULT_SITE_THEME, "zero");
});

test("PATCH /api/settings/site_theme rejects an invalid value with 400", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_theme", { method: "PATCH", body: JSON.stringify({ value: "four" }) }),
    createEnv(db),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  assert.equal(db.calls.length, 0, "驗證失敗不應觸發任何查詢");
});

test("PATCH /api/settings/site_theme accepts a valid value and persists it", async () => {
  const db = createRecordingDatabase();
  const response = await worker.fetch(
    apiRequest("/api/settings/site_theme", { method: "PATCH", body: JSON.stringify({ value: "two" }) }),
    createEnv(db),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.value, "two");
  assert.ok(
    db.calls.find((call) => call.sql.includes("INSERT INTO site_settings")),
    "應該有一次寫入 site_settings",
  );
});

test("GET /api/settings/site_theme requires authentication too", async () => {
  const response = await worker.fetch(
    apiRequest("/api/settings/site_theme", {}, { authenticated: false }),
    createEnv(createRecordingDatabase()),
  );

  assert.equal(response.status, 401);
});

test("存到不合法的配色值時讀出來會落回 zero，不讓壞資料弄壞整個站", async () => {
  const db = createRecordingDatabase({ storedRow: { value: "rainbow" } });
  const response = await worker.fetch(apiRequest("/api/settings/site_theme"), createEnv(db));

  assert.equal((await response.json()).data.value, "zero");
});

// ---------------------------------------------------------------- 公開端點：/api/site
//
// 與 /api/settings/site_name、/api/settings/site_logo 是不同端點（見
// src/routes/site.js 檔頭註解）：這個不需要登入，且只回白名單內的欄位，
// 不能被拿來當成其他設定的洩漏出口。管理後台關閉（ADMIN_ENABLED 非
// "true"）時仍要能用——公開首頁不該因為後台被關掉就連站名／圖示都拿不到。

test("GET /api/site works without authentication and admin disabled", async () => {
  const db = createRecordingDatabase({ storedRow: { value: "李老師的AI展示中心" } });
  const response = await worker.fetch(
    apiRequest("/api/site", {}, { authenticated: false }),
    { ASSETS: { fetch: async () => new Response("STATIC") }, DB: db },
  );

  assert.equal(response.status, 200);
  // storedRow 的值不是合法的 logo 代號，所以 site_logo 這裡會落回預設值——
  // 這個假 DB 對任何 key 的查詢都回同一個 storedRow（見 createRecordingDatabase）。
  assert.deepEqual(await response.json(), {
    data: { site_name: "李老師的AI展示中心", site_logo: DEFAULT_SITE_LOGO, site_theme: DEFAULT_SITE_THEME },
  });
});

test("GET /api/site returns exactly the public settings whitelist, never any other key", async () => {
  // 這裡刻意用「完全等於」而不是「包含」比對：新增可公開設定時，必須同時
  // 更新 src/routes/site.js 的 PUBLIC_SETTINGS_KEYS 白名單與這個斷言——
  // 這是防止不小心把非公開設定（例如管理後台密碼相關的鍵）倒出去的守門
  // 測試，兩邊都要手動改才會被這個測試擋下來，故意不共用同一份陣列參照。
  const db = createRecordingDatabase({ storedRow: { value: "logo-02" } });
  const response = await worker.fetch(
    apiRequest("/api/site", {}, { authenticated: false }),
    { ASSETS: { fetch: async () => new Response("STATIC") }, DB: db },
  );

  const body = await response.json();
  assert.deepEqual(Object.keys(body.data), ["site_name", "site_logo", "site_theme"]);
});

test("GET /api/site falls back to the neutral defaults when unset", async () => {
  const db = createRecordingDatabase({ storedRow: null });
  const response = await worker.fetch(
    apiRequest("/api/site", {}, { authenticated: false }),
    { ASSETS: { fetch: async () => new Response("STATIC") }, DB: db },
  );

  assert.deepEqual(await response.json(), {
    data: { site_name: DEFAULT_SITE_NAME, site_logo: DEFAULT_SITE_LOGO, site_theme: DEFAULT_SITE_THEME },
  });
});

test("unsupported methods on /api/site return 405 with Allow", async () => {
  const response = await worker.fetch(
    apiRequest("/api/site", { method: "DELETE" }, { authenticated: false }),
    { ASSETS: { fetch: async () => new Response("STATIC") }, DB: createRecordingDatabase() },
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("unknown /api/site sub-paths return 404", async () => {
  const response = await worker.fetch(
    apiRequest("/api/site/extra", {}, { authenticated: false }),
    { ASSETS: { fetch: async () => new Response("STATIC") }, DB: createRecordingDatabase() },
  );

  assert.equal(response.status, 404);
});
