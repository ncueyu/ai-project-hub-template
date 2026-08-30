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
