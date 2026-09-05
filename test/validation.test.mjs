import assert from "node:assert/strict";
import test from "node:test";

import {
  isHttpOrHttpsUrl,
  validateLinkCreate,
  validateLinkPatch,
  validateProjectCreate,
  validateProjectPatch,
  validateTaxonomy,
} from "../src/validation.js";

/** 一組通過驗證的最小 payload，個別測試再覆寫要驗的欄位。 */
function baseProject(overrides = {}) {
  return {
    name: "電阻色碼教學工具",
    slug: "resistor-color-code",
    visibility: "public",
    platform: "cloudflare",
    ...overrides,
  };
}

test("minimal valid project fills in the documented defaults", () => {
  const result = validateProjectCreate(baseProject());

  assert.equal(result.ok, true);
  assert.equal(result.value.project_type, "other");
  assert.equal(result.value.database_type, "none");
  assert.equal(result.value.description, "");
  assert.deepEqual(result.value.tag_ids, []);
  assert.equal(result.value.category_id, null);
});

test("name is trimmed and bounded to 100 characters", () => {
  const trimmed = validateProjectCreate(baseProject({ name: "  邊界測試  " }));
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.value.name, "邊界測試");

  const tooLong = validateProjectCreate(baseProject({ name: "a".repeat(101) }));
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.fields.name);

  const empty = validateProjectCreate(baseProject({ name: "   " }));
  assert.equal(empty.ok, false);
  assert.ok(empty.fields.name);
});

test("slug only accepts the documented pattern", () => {
  const accepted = ["a", "abc", "a-b", "project-1", "1-2-3"];

  for (const slug of accepted) {
    assert.equal(validateProjectCreate(baseProject({ slug })).ok, true, `應接受 ${slug}`);
  }

  const rejected = ["-lead", "trail-", "double--dash", "Upper", "有中文", "with space", "under_score", ""];

  for (const slug of rejected) {
    const result = validateProjectCreate(baseProject({ slug }));
    assert.equal(result.ok, false, `應拒絕 ${slug}`);
    assert.ok(result.fields.slug);
  }
});

test("enum fields reject values outside the fixed set", () => {
  const cases = [
    ["visibility", "INVALID"],
    ["platform", "aws"],
    ["project_type", "mobile"],
    ["database_type", "mysql"],
  ];

  for (const [field, value] of cases) {
    const result = validateProjectCreate(baseProject({ [field]: value }));
    assert.equal(result.ok, false, `${field} 應拒絕 ${value}`);
    assert.ok(result.fields[field]);
  }
});

test("all five visibility states are accepted", () => {
  for (const visibility of ["public", "unlisted", "password", "private", "disabled"]) {
    assert.equal(validateProjectCreate(baseProject({ visibility })).ok, true, visibility);
  }
});

test("url fields accept empty values but require https", () => {
  const empty = validateProjectCreate(baseProject({ deployment_url: "" }));
  assert.equal(empty.ok, true);
  assert.equal(empty.value.deployment_url, null);

  const nulled = validateProjectCreate(baseProject({ deployment_url: null }));
  assert.equal(nulled.ok, true);
  assert.equal(nulled.value.deployment_url, null);

  const https = validateProjectCreate(baseProject({ deployment_url: "https://example.test/app" }));
  assert.equal(https.ok, true);

  for (const bad of ["http://example.test", "javascript:alert(1)", "ftp://example.test", "not-a-url"]) {
    const result = validateProjectCreate(baseProject({ deployment_url: bad }));
    assert.equal(result.ok, false, `應拒絕 ${bad}`);
    assert.ok(result.fields.deployment_url);
  }
});

test("tag_ids must be positive integers and are de-duplicated", () => {
  const deduped = validateProjectCreate(baseProject({ tag_ids: [3, 1, 3, 1] }));
  assert.equal(deduped.ok, true);
  assert.deepEqual(deduped.value.tag_ids, [3, 1]);

  for (const bad of [["1"], [0], [-2], [1.5], "not-array"]) {
    const result = validateProjectCreate(baseProject({ tag_ids: bad }));
    assert.equal(result.ok, false, `應拒絕 ${JSON.stringify(bad)}`);
  }
});

test("missing required fields are reported together", () => {
  const result = validateProjectCreate({});

  assert.equal(result.ok, false);
  assert.ok(result.fields.name);
  assert.ok(result.fields.slug);
  assert.ok(result.fields.visibility);
  assert.ok(result.fields.platform);
});

test("patch only returns fields that were explicitly present", () => {
  const result = validateProjectPatch({ name: "只改名稱" });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value), ["name"]);
});

test("patch rejects an empty payload", () => {
  const result = validateProjectPatch({});

  assert.equal(result.ok, false);
});

test("patch still validates the fields that are present", () => {
  const result = validateProjectPatch({ visibility: "INVALID" });

  assert.equal(result.ok, false);
  assert.ok(result.fields.visibility);
});

test("patch can clear nullable fields explicitly", () => {
  const result = validateProjectPatch({ category_id: null, worker_name: null });

  assert.equal(result.ok, true);
  assert.equal(result.value.category_id, null);
  assert.equal(result.value.worker_name, null);
});

test("category validation includes description and sort order", () => {
  const result = validateTaxonomy(
    { name: "教學工具", slug: "teaching", description: "說明", sort_order: 3 },
    { withDescription: true, withSortOrder: true, partial: false },
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.sort_order, 3);
});

test("tag validation ignores category-only fields", () => {
  const result = validateTaxonomy(
    { name: "電子", slug: "electronics", description: "應被忽略", sort_order: 5 },
    { withDescription: false, withSortOrder: false, partial: false },
  );

  assert.equal(result.ok, true);
  assert.equal("description" in result.value, false);
  assert.equal("sort_order" in result.value, false);
});

test("taxonomy slug follows the same rule as project slug", () => {
  const result = validateTaxonomy(
    { name: "壞代稱", slug: "Bad Slug" },
    { withDescription: false, withSortOrder: false, partial: false },
  );

  assert.equal(result.ok, false);
  assert.ok(result.fields.slug);
});

// ---------------------------------------------------------------- 推薦連結（links）
//
// 網址驗證是這次的核心裁決：http 與 https 都接受（2026-08-27 使用者裁決，
// 否決了「只收 https」的原始提案），因為校內系統的連結常常是內部 http 網址。

test("isHttpOrHttpsUrl accepts both http and https, rejects everything else", () => {
  for (const url of ["https://example.test", "http://example.test", "http://192.168.1.1/portal"]) {
    assert.equal(isHttpOrHttpsUrl(url), true, url);
  }

  for (const bad of ["ftp://example.test", "javascript:alert(1)", "not-a-url", "", "  ", null, undefined, 123]) {
    assert.equal(isHttpOrHttpsUrl(bad), false, String(bad));
  }
});

function baseLink(overrides = {}) {
  return {
    name: "示範連結",
    url: "https://example.test",
    ...overrides,
  };
}

test("minimal valid link fills in the documented defaults", () => {
  const result = validateLinkCreate(baseLink());

  assert.equal(result.ok, true);
  assert.equal(result.value.description, "");
  assert.equal(result.value.icon, "");
  assert.equal(result.value.category_id, null);
  assert.equal(result.value.sort_order, 0);
  assert.equal(result.value.is_listed, true);
});

test("link create accepts an http url, not only https", () => {
  const result = validateLinkCreate(baseLink({ url: "http://192.168.1.1/portal" }));

  assert.equal(result.ok, true);
  assert.equal(result.value.url, "http://192.168.1.1/portal");
});

test("link create rejects a non-http(s) url", () => {
  for (const url of ["ftp://example.test", "javascript:alert(1)", "not-a-url", ""]) {
    const result = validateLinkCreate(baseLink({ url }));
    assert.equal(result.ok, false, url);
    assert.ok(result.fields.url, url);
  }
});

test("link create rejects a missing name", () => {
  const result = validateLinkCreate(baseLink({ name: "" }));

  assert.equal(result.ok, false);
  assert.ok(result.fields.name);
});

test("link create accepts an emoji icon and rejects an overlong one", () => {
  const withIcon = validateLinkCreate(baseLink({ icon: "🔗" }));
  assert.equal(withIcon.ok, true);
  assert.equal(withIcon.value.icon, "🔗");

  const tooLong = validateLinkCreate(baseLink({ icon: "a".repeat(33) }));
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.fields.icon);
});

test("link create rejects a non-integer sort_order and a non-boolean is_listed", () => {
  const badSortOrder = validateLinkCreate(baseLink({ sort_order: 1.5 }));
  assert.equal(badSortOrder.ok, false);
  assert.ok(badSortOrder.fields.sort_order);

  const badIsListed = validateLinkCreate(baseLink({ is_listed: "yes" }));
  assert.equal(badIsListed.ok, false);
  assert.ok(badIsListed.fields.is_listed);
});

test("link patch only touches fields present in the payload", () => {
  const result = validateLinkPatch({ is_listed: false });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value), ["is_listed"]);
  assert.equal(result.value.is_listed, false);
});

test("link patch rejects an empty payload", () => {
  const result = validateLinkPatch({});

  assert.equal(result.ok, false);
  assert.ok(result.fields._);
});

// ── 縮圖網址（2026-08-30 使用者實測後才發現的缺陷）────────────────
//
// 上傳 API 寫回資料庫、也填回表單的是 `/media/thumbnails/<uuid>.png` 這種
// 相對路徑，而 thumbnail_url 原本走 readHttpsUrl()——只收絕對的 https 網址。
// 於是：按下「上傳圖片」→ 201 成功、欄位自動填入 → 按下「儲存」→ 驗證失敗
// 「不是有效的網址」。圖其實已經存進去了，但使用者看到紅字會以為整件事沒成功。

test("thumbnail_url 接受本站自己的縮圖路徑", () => {
  const paths = [
    // 上傳按鈕與 hub thumbnail 存進 D1 之後產生的形狀
    "/media/thumbnails/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png",
    // 2026-08-30 之前 hub ship 複製成靜態檔的舊制路徑，線上仍有專案指向它
    "/thumbnails/exam-quiz.png",
    "/thumbnails/我的截圖.jpg",
    "/thumbnails/x.webp",
    "/thumbnails/x.avif",
  ];

  for (const path of paths) {
    const result = validateProjectPatch({ thumbnail_url: path });

    assert.equal(result.ok, true, `${path} 應該通過：${JSON.stringify(result.fields)}`);
    assert.equal(result.value.thumbnail_url, path);
  }
});

test("thumbnail_url 不接受看起來像相對路徑、其實會連到別人網域的值", () => {
  /*
   * `//evil.com/x.png` 開頭也是斜線，但瀏覽器把它當成**絕對網址**（協定相對），
   * 於是變成從別人的網域載入圖片。所以這裡用白名單而不是「開頭是斜線就放行」。
   */
  const rejected = [
    "//evil.com/x.png",
    "/\evil.com/x.png",
    "/media/thumbnails/../../etc/passwd",
    "/admin/index.html",
    "/thumbnails/x.svg",
    "/thumbnails/",
    "/thumbnails/x.png?a=b",
    "/thumbnails/x.png#frag",
  ];

  for (const value of rejected) {
    const result = validateProjectPatch({ thumbnail_url: value });

    assert.equal(result.ok, false, `${value} 應該被擋下`);
    assert.ok(result.fields.thumbnail_url);
  }
});

test("thumbnail_url 仍然只接受 https 的外部網址", () => {
  assert.equal(validateProjectPatch({ thumbnail_url: "https://example.com/a.png" }).ok, true);

  for (const value of ["http://example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA"]) {
    assert.equal(validateProjectPatch({ thumbnail_url: value }).ok, false, `${value} 應該被擋下`);
  }
});

test("thumbnail_url 的空值代表「沒有縮圖」，不是錯誤", () => {
  for (const value of [null, ""]) {
    const result = validateProjectPatch({ thumbnail_url: value });

    assert.equal(result.ok, true);
    assert.equal(result.value.thumbnail_url, null);
  }
});

test("建立專案時的 thumbnail_url 走同一套規則", () => {
  // 兩條路徑各有一份呼叫，改一邊忘了另一邊的話這裡會紅。
  const result = validateProjectCreate(
    baseProject({ thumbnail_url: "/media/thumbnails/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png" }),
  );

  assert.equal(result.ok, true, JSON.stringify(result.fields));
});

/* ------------------------------------------------------------------ *
 * 顯示順序 sort_order（2026-09-06）
 * ------------------------------------------------------------------ */

test("patch 接受 sort_order 整數", () => {
  const result = validateProjectPatch({ sort_order: 3 });

  assert.equal(result.ok, true, JSON.stringify(result.fields));
  assert.equal(result.value.sort_order, 3);
});

test("patch 接受 sort_order 為 0——那是 migration 0003 定義的「尚未指定」中性值", () => {
  const result = validateProjectPatch({ sort_order: 0 });

  assert.equal(result.ok, true, JSON.stringify(result.fields));
  assert.equal(result.value.sort_order, 0);
});

test("patch 拒絕負數的 sort_order", () => {
  // 展示中心是 ORDER BY sort_order ASC。負數等於開放一個「比未指定還前面」
  // 的區間，那個區間沒有語意，只會讓「為什麼這張跑到最前面」變成無解的問題。
  const result = validateProjectPatch({ sort_order: -1 });

  assert.equal(result.ok, false);
  assert.ok(result.fields.sort_order);
});

test("patch 拒絕非整數的 sort_order", () => {
  for (const bad of [1.5, "2", null, true, []]) {
    const result = validateProjectPatch({ sort_order: bad });

    assert.equal(result.ok, false, `${JSON.stringify(bad)} 應該被拒絕`);
    assert.ok(result.fields.sort_order, `${JSON.stringify(bad)} 應該指出是 sort_order 的問題`);
  }
});
