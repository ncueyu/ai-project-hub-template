import assert from "node:assert/strict";
import test from "node:test";

import {
  MANIFEST_FIELDS,
  MANIFEST_FILENAME,
  parseManifest,
  validateManifest,
} from "../src/hub/manifest.js";

test("minimal manifest only needs a name and a slug", () => {
  const result = validateManifest({ name: "電阻色碼教學工具", slug: "resistor-color-code" });

  assert.equal(result.ok, true);
  assert.equal(result.value.platform, "cloudflare");
  assert.equal(result.value.project_type, "other");
  assert.equal(result.value.database_type, "none");
});

test("visibility defaults to private so a forgotten field never publishes anything", () => {
  const result = validateManifest({ name: "半成品", slug: "work-in-progress" });

  assert.equal(result.ok, true);
  assert.equal(result.value.visibility, "private");
});

test("a misspelled field is reported instead of being silently ignored", () => {
  const result = validateManifest({
    name: "測試",
    slug: "test-project",
    plaform: "cloudflare",
  });

  assert.equal(result.ok, false);
  assert.ok(result.fields.plaform);
  assert.match(result.fields.plaform, /不是/);
});

test("fields outside the manifest whitelist are rejected even when valid elsewhere", () => {
  // tag_ids 是 API 認得的欄位，但 Manifest 不接受——出現它代表使用者
  // 誤把 API payload 當成 Manifest 在寫。
  const result = validateManifest({ name: "測試", slug: "test-project", tag_ids: [1, 2] });

  assert.equal(result.ok, false);
  assert.ok(result.fields.tag_ids);
});

test("slug format follows the same rule as the rest of the system", () => {
  const bad = validateManifest({ name: "測試", slug: "Not A Slug" });

  assert.equal(bad.ok, false);
  assert.ok(bad.fields.slug);

  const good = validateManifest({ name: "測試", slug: "a-valid-slug-123" });

  assert.equal(good.ok, true);
});

test("enum fields reject unknown values", () => {
  const result = validateManifest({
    name: "測試",
    slug: "test-project",
    platform: "netlify",
    visibility: "secret",
  });

  assert.equal(result.ok, false);
  assert.ok(result.fields.platform);
  assert.ok(result.fields.visibility);
});

test("non-object input is rejected with a whole-file message", () => {
  for (const input of [null, [], "text", 42]) {
    const result = validateManifest(input);

    assert.equal(result.ok, false);
    assert.ok(result.fields._);
  }
});

test("broken JSON is reported separately from field problems", () => {
  const result = parseManifest("{ name: 沒有引號 }");

  assert.equal(result.ok, false);
  assert.ok(result.fields._);
  assert.match(result.fields._, new RegExp(MANIFEST_FILENAME));
});

test("a UTF-8 BOM does not break parsing", () => {
  // Windows 記事本與 PowerShell 的 Out-File 預設都會寫入 BOM。
  const withBom = `﻿${JSON.stringify({ name: "測試", slug: "test-project" })}`;
  const result = parseManifest(withBom);

  assert.equal(result.ok, true);
  assert.equal(result.value.slug, "test-project");
});

test("parseManifest returns exactly the manifest fields and nothing else", () => {
  const result = parseManifest(JSON.stringify({ name: "測試", slug: "test-project" }));

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), [...MANIFEST_FIELDS].sort());
});
