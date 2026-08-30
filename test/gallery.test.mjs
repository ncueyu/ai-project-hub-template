import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

/**
 * 依 SQL 內容回應的假 D1。
 *
 * Gallery 會並行執行「查專案」與「查篩選選項」，用先進先出的佇列會因為
 * 執行順序不固定而不穩定，因此改用 SQL 特徵來決定回傳內容。
 */
function createGalleryDatabase({
  projects = [],
  projectTags = [],
  categories = [],
  tags = [],
  links = [],
  galleryLayoutRow = null,
  unlistedCountRow = null,
} = {}) {
  const calls = [];

  return {
    calls,
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async all() {
          calls.push({ sql, params: statement.params });

          if (sql.includes("FROM projects p")) {
            return { results: projects };
          }

          // attachTags：以專案 ID 反查標籤
          if (sql.includes("FROM project_tags pt") && sql.includes("WHERE pt.project_id IN")) {
            return { results: projectTags };
          }

          if (sql.includes("FROM categories c")) {
            return { results: categories };
          }

          if (sql.includes("FROM tags t")) {
            return { results: tags };
          }

          if (sql.includes("FROM links l")) {
            return { results: links };
          }

          return { results: [] };
        },
        async first() {
          calls.push({ sql, params: statement.params });

          if (sql.includes("FROM site_settings")) {
            return galleryLayoutRow;
          }

          // countUnlistedProjects()：唯一走 first() 又查 projects 的地方。
          if (sql.includes("COUNT(*) AS total") && sql.includes("FROM projects p")) {
            return unlistedCountRow;
          }

          return null;
        },
        async run() {
          calls.push({ sql, params: statement.params });
          return { success: true };
        },
      };

      return statement;
    },
    async batch(statements) {
      return statements.map(() => ({ success: true }));
    },
  };
}

function createEnv(db) {
  return { ASSETS: { fetch: async () => new Response("STATIC") }, DB: db };
}

function galleryRequest(path = "/api/gallery/projects", init = {}) {
  return new Request(`https://hub.example.test${path}`, init);
}

const SAMPLE_PROJECT = {
  id: 1,
  name: "電阻色碼互動練習",
  slug: "resistor-color-code",
  description: "示範",
  deployment_url: "https://example.test/app",
  thumbnail_url: null,
  updated_at: "2026-08-10T00:00:00Z",
  last_deployed_at: "2026-08-10T00:00:00Z",
  category_id: 1,
  category_name: "教學工具",
  category_slug: "teaching",
};

test("gallery query always constrains visibility to the listed states", async () => {
  const db = createGalleryDatabase({ projects: [SAMPLE_PROJECT] });
  await worker.fetch(galleryRequest(), createEnv(db));

  const projectQuery = db.calls.find((call) => call.sql.includes("FROM projects p"));

  assert.ok(projectQuery, "應該查詢 projects");
  assert.ok(
    projectQuery.sql.includes("p.visibility IN ('public', 'password')"),
    "visibility 條件必須寫死在 SQL 中",
  );

  // 比原本的斷言更嚴：不只要求「有正確條件」，還要求「沒有多出來的狀態」。
  // 只檢查前者的話，條件被放寬成 IN ('public','password','private') 也照樣通過。
  for (const hidden of ["unlisted", "private", "disabled"]) {
    assert.equal(
      projectQuery.sql.includes(`'${hidden}'`),
      false,
      `${hidden} 不得出現在展示中心的查詢條件裡`,
    );
  }
});

test("gallery response exposes only publishable fields", async () => {
  const db = createGalleryDatabase({
    projects: [SAMPLE_PROJECT],
    projectTags: [{ project_id: 1, id: 5, name: "互動", slug: "interactive" }],
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();
  const [project] = body.data.items;

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(project).sort(), [
    "category",
    "deployment_url",
    "description",
    "id",
    "is_primary",
    "last_deployed_at",
    "name",
    "requires_password",
    "slug",
    "tags",
    "thumbnail_url",
    "updated_at",
  ]);
  assert.equal(project.category.slug, "teaching");
  assert.deepEqual(project.tags, [{ id: 5, name: "互動", slug: "interactive" }]);
});

test("gallery orders by sort_order first, so a primary card always leads and untouched projects keep their old relative order", async () => {
  // 這是機械式檢查 SQL 文字，而不是靠假 DB 實際排序（假 DB 只是原樣回傳
  // 給定的陣列，不會真的執行 ORDER BY）。2026-08-28 工作計畫 Part D 的
  // 驗收條件要求「反向測試」：把 `p.sort_order ASC` 從 ORDER BY 拿掉，
  // 這個斷言就會轉紅；改回來才會轉綠——這正是這個斷言的作用。
  //
  // 為什麼 `sort_order ASC` 必須排在最前面而不是排在後面：sort_order 相同
  // （既有專案預設都是 0）時，後面的 `updated_at DESC, p.id DESC` 才會
  // 接手決定順序，效果等同於改動前的排序——這就是「既有專案不設定也
  // 不會亂序」成立的原因。
  const db = createGalleryDatabase({ projects: [SAMPLE_PROJECT] });
  await worker.fetch(galleryRequest(), createEnv(db));

  const projectQuery = db.calls.find((call) => call.sql.includes("FROM projects p"));

  assert.ok(projectQuery, "應該查詢 projects");
  assert.ok(
    projectQuery.sql.includes("ORDER BY p.sort_order ASC, p.updated_at DESC, p.id DESC"),
    "排序必須先比 sort_order，sort_order 相同時才比 updated_at／id",
  );
});

test("a project with sort_order 1 is marked as the primary card", async () => {
  const db = createGalleryDatabase({
    projects: [{ ...SAMPLE_PROJECT, sort_order: 1 }],
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal(body.data.items[0].is_primary, true);
});

test("a project without sort_order 1 (including the untouched default) is not marked as primary", async () => {
  const db = createGalleryDatabase({
    // sort_order 缺席，模擬既有專案從未被設為主卡片、欄位仍是預設值 0 的情境。
    projects: [SAMPLE_PROJECT, { ...SAMPLE_PROJECT, id: 2, sort_order: 2 }],
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal(body.data.items[0].is_primary, false);
  assert.equal(body.data.items[1].is_primary, false);
});

test("gallery response never contains admin-only fields", async () => {
  const db = createGalleryDatabase({ projects: [SAMPLE_PROJECT] });
  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const text = await response.text();

  for (const field of ["repository_url", "worker_name", "password_hash", "policy_version", "visibility"]) {
    assert.equal(text.includes(field), false, `回應不應包含 ${field}`);
  }
});

test("a password project is listed and marked as needing a password", async () => {
  const db = createGalleryDatabase({
    projects: [{ ...SAMPLE_PROJECT, visibility: "password" }],
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();
  const [project] = body.data.items;

  assert.equal(response.status, 200);
  assert.equal(project.requires_password, true, "加密專案必須標記需要密碼");
  assert.equal(project.name, "電阻色碼互動練習", "名稱照樣公開，這是 A 方案（全部顯示）");
  assert.equal("visibility" in project, false, "標記用布林值表達，不得輸出 visibility 原值");
});

test("a public project is not marked as needing a password", async () => {
  const db = createGalleryDatabase({
    projects: [{ ...SAMPLE_PROJECT, visibility: "public" }],
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal(body.data.items[0].requires_password, false);
});

test("filter counts cover the same states as the project query", async () => {
  // 統計範圍與專案查詢不一致的話，加密專案的分類不會出現在篩選選單裡，
  // 那個專案就等於被篩選功能藏起來——列出了卻篩不到，比不列出更難察覺。
  const db = createGalleryDatabase({ projects: [] });
  await worker.fetch(galleryRequest(), createEnv(db));

  const filterQueries = db.calls.filter((call) => call.sql.includes("JOIN projects p"));

  assert.equal(filterQueries.length, 2, "分類與標籤各一個統計查詢");

  for (const query of filterQueries) {
    assert.ok(
      query.sql.includes("p.visibility IN ('public', 'password')"),
      "篩選統計的可見性範圍必須與專案查詢一致",
    );
  }
});

test("category and tag filters travel as bound parameters", async () => {
  const db = createGalleryDatabase({ projects: [] });
  await worker.fetch(
    galleryRequest("/api/gallery/projects?category=teaching&tag=interactive"),
    createEnv(db),
  );

  const projectQuery = db.calls.find((call) => call.sql.includes("FROM projects p"));

  assert.ok(projectQuery.params.includes("teaching"));
  assert.ok(projectQuery.params.includes("interactive"));
  assert.equal(projectQuery.sql.includes("teaching"), false, "篩選值不可拼進 SQL");
});

test("an unknown visibility query parameter cannot widen the result set", async () => {
  const db = createGalleryDatabase({ projects: [SAMPLE_PROJECT] });
  await worker.fetch(
    galleryRequest("/api/gallery/projects?visibility=private"),
    createEnv(db),
  );

  const projectQuery = db.calls.find((call) => call.sql.includes("FROM projects p"));

  assert.ok(projectQuery.sql.includes("p.visibility IN ('public', 'password')"));
  assert.equal(projectQuery.params.includes("private"), false);
});

test("gallery projects without a category serialise category as null", async () => {
  const db = createGalleryDatabase({
    projects: [{ ...SAMPLE_PROJECT, category_id: null, category_name: null, category_slug: null }],
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal(body.data.items[0].category, null);
});

test("gallery is read-only", async () => {
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    const response = await worker.fetch(
      galleryRequest("/api/gallery/projects", { method }),
      createEnv(createGalleryDatabase()),
    );

    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
});

test("unknown gallery sub-paths return 404", async () => {
  for (const path of ["/api/gallery", "/api/gallery/unknown", "/api/gallery/projects/1"]) {
    const response = await worker.fetch(galleryRequest(path), createEnv(createGalleryDatabase()));

    assert.equal(response.status, 404, path);
  }
});

test("filters only report taxonomy attached to listed projects", async () => {
  const db = createGalleryDatabase({
    projects: [SAMPLE_PROJECT],
    categories: [{ id: 1, name: "教學工具", slug: "teaching", count: 1 }],
    tags: [{ id: 5, name: "互動", slug: "interactive", count: 1 }],
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.deepEqual(body.data.filters.categories, [{ id: 1, name: "教學工具", slug: "teaching", count: 1 }]);
  assert.deepEqual(body.data.filters.tags, [{ id: 5, name: "互動", slug: "interactive", count: 1 }]);

  // 兩個統計查詢都必須自行限制可見性範圍，不能依賴呼叫端
  const categoryQuery = db.calls.find((call) => call.sql.includes("FROM categories c"));
  const tagQuery = db.calls.find((call) => call.sql.includes("FROM tags t") && call.sql.includes("GROUP BY"));

  assert.ok(categoryQuery.sql.includes("p.visibility IN ('public', 'password')"));
  assert.ok(tagQuery.sql.includes("p.visibility IN ('public', 'password')"));
});

// ---------------------------------------------------------------- 版面設定（gallery_layout）
//
// 夾帶在既有的 /api/gallery/projects 回應裡（2026-08-27 工作計畫第 2-3 節 (1)），
// 不另開端點——展示中心本來就要等這個 fetch 才渲染卡片。

test("gallery projects response carries the stored gallery_layout", async () => {
  const db = createGalleryDatabase({ projects: [], galleryLayoutRow: { value: "list" } });
  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal(body.data.gallery_layout, "list");
});

test("gallery projects response falls back to the default layout when unset", async () => {
  const db = createGalleryDatabase({ projects: [], galleryLayoutRow: null });
  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal(body.data.gallery_layout, "grid");
});

// ---------------------------------------------------------------- 推薦連結（/api/gallery/links）
//
// 獨立端點，不需要驗證（比照 /api/gallery/projects）——連結是分區呈現、
// 與專案無關（2026-08-27 工作計畫第 2-3 節 (2)）。

const SAMPLE_LINK = {
  id: 1,
  name: "外部工具",
  url: "https://example.test/tool",
  description: "老師推薦",
  icon: "🔗",
  category_id: 1,
  category_name: "教學工具",
  category_slug: "teaching",
};

test("gallery links endpoint requires no authentication", async () => {
  const db = createGalleryDatabase({ links: [SAMPLE_LINK] });
  const response = await worker.fetch(galleryRequest("/api/gallery/links"), createEnv(db));

  assert.equal(response.status, 200);
});

test("gallery links query only selects is_listed = 1", async () => {
  const db = createGalleryDatabase({ links: [SAMPLE_LINK] });
  await worker.fetch(galleryRequest("/api/gallery/links"), createEnv(db));

  const query = db.calls.find((call) => call.sql.includes("FROM links l"));

  assert.ok(query, "應該查詢 links");
  assert.ok(query.sql.includes("WHERE l.is_listed = 1"), "公開端點必須只查 is_listed = 1 的連結");
});

test("gallery links response exposes only publishable fields", async () => {
  const db = createGalleryDatabase({ links: [SAMPLE_LINK] });
  const response = await worker.fetch(galleryRequest("/api/gallery/links"), createEnv(db));
  const body = await response.json();
  const [link] = body.data.items;

  assert.deepEqual(Object.keys(link).sort(), ["category", "description", "icon", "id", "name", "url"]);
  assert.equal(link.category.slug, "teaching");
});

test("gallery links response never contains the is_listed flag", async () => {
  const db = createGalleryDatabase({ links: [SAMPLE_LINK] });
  const response = await worker.fetch(galleryRequest("/api/gallery/links"), createEnv(db));
  const text = await response.text();

  assert.equal(text.includes("is_listed"), false);
});

test("gallery links is read-only", async () => {
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    const response = await worker.fetch(
      galleryRequest("/api/gallery/links", { method }),
      createEnv(createGalleryDatabase()),
    );

    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
});

/* ==========================================================================
 * 未公開專案的數量（2026-08-29 新增，工作計畫階段 5）
 *
 * 這個欄位存在的理由：新專案登錄時一律是 private（刻意的安全預設），而展示中心
 * 只列出 public 與 password。所以使用者成功部署第一個專案之後，展示中心仍然是
 * 空的——空狀態畫面必須能分辨「還沒有任何專案」與「有專案但都沒公開」，
 * 否則會對一個明明成功了的人說「去部署一個吧」。
 *
 * 它同時是一個**資訊揭露面**，所以下面的測試重點不只是「數字對不對」，
 * 更是「除了數字之外什麼都沒漏出去」，以及「不需要的時候根本不輸出」。
 * ========================================================================== */

test("有專案可列出時，回應不含 unlisted_count，也不會去查那個數字", async () => {
  const db = createGalleryDatabase({
    projects: [SAMPLE_PROJECT],
    unlistedCountRow: { total: 7 },
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal("unlisted_count" in body.data, false, "有東西可看時不該輸出這個數字");

  const countQueries = db.calls.filter((call) => call.sql.includes("COUNT(*) AS total") && call.sql.includes("FROM projects p"));
  assert.equal(countQueries.length, 0, "有東西可看時連查詢都不該發出——少一次查詢也少一次揭露機會");
});

test("沒有可列出的專案、但有未公開專案時，回應帶上數量", async () => {
  const db = createGalleryDatabase({
    projects: [],
    unlistedCountRow: { total: 3 },
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal(body.data.unlisted_count, 3);
});

test("完全沒有專案時不輸出 unlisted_count，讓前端顯示「還沒有專案」那一種文案", async () => {
  const db = createGalleryDatabase({ projects: [], unlistedCountRow: { total: 0 } });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  assert.equal("unlisted_count" in body.data, false);
});

test("unlisted_count 只是一個數字——回應的頂層鍵集合不含任何專案細節", async () => {
  const db = createGalleryDatabase({
    projects: [],
    unlistedCountRow: { total: 2 },
  });

  const response = await worker.fetch(galleryRequest(), createEnv(db));
  const body = await response.json();

  // 精確斷言頂層鍵集合。這是本組測試的核心防線：日後若有人把
  // countUnlistedProjects() 改成回傳整列資料、或順手在這裡多塞一個欄位，
  // 這一行會立刻變紅。
  assert.deepEqual(Object.keys(body.data).sort(), [
    "applied",
    "filters",
    "gallery_layout",
    "items",
    "unlisted_count",
  ]);
  assert.equal(typeof body.data.unlisted_count, "number");
});

test("數量的統計範圍是「不可列出的狀態」，與專案查詢互補", async () => {
  const db = createGalleryDatabase({ projects: [], unlistedCountRow: { total: 1 } });

  await worker.fetch(galleryRequest(), createEnv(db));

  const countQuery = db.calls.find((call) => call.sql.includes("COUNT(*) AS total") && call.sql.includes("FROM projects p"));
  assert.ok(countQuery, "應該發出一次數量查詢");

  // 用 NOT (visibility IN (...)) 而不是另寫一份狀態清單：清單只有一份，
  // 日後 GALLERY_LISTED_STATES 增減時兩邊不會分岔。
  assert.ok(countQuery.sql.includes("NOT ("), "應該用 NOT (…) 取補集");
  assert.ok(countQuery.sql.includes("'public'"), "補集的依據應該就是可列出狀態清單");
  assert.ok(countQuery.sql.includes("'password'"));
  assert.equal(countQuery.params.length, 0, "這個查詢不該有任何外部參數");
});

test("壞掉的數量值不會變成畫面上的 NaN", async () => {
  for (const bad of [{ total: null }, { total: "abc" }, { total: -5 }, {}]) {
    const db = createGalleryDatabase({ projects: [], unlistedCountRow: bad });
    const response = await worker.fetch(galleryRequest(), createEnv(db));
    const body = await response.json();

    assert.equal(
      "unlisted_count" in body.data,
      false,
      `壞值 ${JSON.stringify(bad)} 應該被收斂成 0 並因此不輸出`,
    );
  }
});
