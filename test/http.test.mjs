import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BODY_BYTES,
  jsonData,
  jsonError,
  methodNotAllowed,
  readJsonBody,
  rejectCrossSite,
} from "../src/http.js";

function jsonRequest(body, headers = {}) {
  return new Request("https://hub.example.test/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

test("success responses wrap the payload in data and never cache", async () => {
  const response = jsonData({ id: 1 });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { data: { id: 1 } });
});

test("error responses omit the fields key when there are no field errors", async () => {
  const body = await jsonError(404, "PROJECT_NOT_FOUND", "Project not found.").json();

  assert.deepEqual(body, { error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } });
  assert.equal("fields" in body.error, false);
});

test("error responses include field details when provided", async () => {
  const body = await jsonError(400, "VALIDATION_FAILED", "bad", { slug: "格式錯誤。" }).json();

  assert.deepEqual(body.error.fields, { slug: "格式錯誤。" });
});

test("405 responses always carry an Allow header", async () => {
  const response = methodNotAllowed(["GET", "POST"]);

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, POST");
  assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
});

test("non-json content types are rejected with 415", async () => {
  const result = await readJsonBody(jsonRequest("{}", { "Content-Type": "text/plain" }));

  assert.equal(result.value, null);
  assert.equal(result.response.status, 415);
  assert.equal((await result.response.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("a json content type with charset is still accepted", async () => {
  const result = await readJsonBody(
    jsonRequest(JSON.stringify({ ok: true }), { "Content-Type": "application/json; charset=utf-8" }),
  );

  assert.deepEqual(result.value, { ok: true });
});

test("malformed json is rejected with INVALID_JSON", async () => {
  const result = await readJsonBody(jsonRequest("{not json"));

  assert.equal(result.response.status, 400);
  assert.equal((await result.response.json()).error.code, "INVALID_JSON");
});

test("json arrays and primitives are rejected because payloads must be objects", async () => {
  for (const body of ["[1,2,3]", '"text"', "42", "null"]) {
    const result = await readJsonBody(jsonRequest(body));

    assert.equal(result.response.status, 400, `應拒絕 ${body}`);
    assert.equal((await result.response.json()).error.code, "INVALID_JSON");
  }
});

test("oversized bodies are rejected before parsing", async () => {
  const huge = JSON.stringify({ description: "a".repeat(MAX_BODY_BYTES + 10) });
  const result = await readJsonBody(jsonRequest(huge));

  assert.equal(result.response.status, 413);
  assert.equal((await result.response.json()).error.code, "PAYLOAD_TOO_LARGE");
});

test("body size is measured in bytes, not characters", async () => {
  // 每個中文字在 UTF-8 佔 3 個位元組，字元數看起來安全但位元組數超標。
  const characters = Math.floor(MAX_BODY_BYTES / 2);
  const result = await readJsonBody(jsonRequest(JSON.stringify({ d: "中".repeat(characters) })));

  assert.equal(result.response.status, 413);
});

test("cross-site requests are rejected via Sec-Fetch-Site", async () => {
  for (const site of ["cross-site", "same-site"]) {
    const response = rejectCrossSite(jsonRequest("{}", { "Sec-Fetch-Site": site }));

    assert.ok(response, `應拒絕 ${site}`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "CROSS_SITE_FORBIDDEN");
  }
});

test("same-origin and direct requests are allowed", () => {
  assert.equal(rejectCrossSite(jsonRequest("{}", { "Sec-Fetch-Site": "same-origin" })), null);
  assert.equal(rejectCrossSite(jsonRequest("{}", { "Sec-Fetch-Site": "none" })), null);
  assert.equal(rejectCrossSite(jsonRequest("{}")), null);
});

test("a mismatched Origin header is rejected even without Sec-Fetch-Site", async () => {
  const response = rejectCrossSite(jsonRequest("{}", { Origin: "https://evil.example" }));

  assert.ok(response);
  assert.equal(response.status, 403);
});

test("a matching Origin header is allowed", () => {
  assert.equal(rejectCrossSite(jsonRequest("{}", { Origin: "https://hub.example.test" })), null);
});
