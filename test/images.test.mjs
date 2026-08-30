import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  createObjectKey,
  detectImageType,
  extensionFor,
  isValidObjectKey,
} from "../src/images.js";

/** 以位元組陣列組出測試用的檔案開頭，長度至少 32 以通過最小長度檢查。 */
function bytesOf(...values) {
  const flat = values.flat().map((v) => (typeof v === "string" ? v.charCodeAt(0) : v));
  const out = new Uint8Array(Math.max(32, flat.length));
  out.set(flat);
  return out;
}

function ascii(text) {
  return [...text].map((c) => c.charCodeAt(0));
}

const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = bytesOf([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP = bytesOf([...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WEBP")]);
const AVIF = bytesOf([0x00, 0x00, 0x00, 0x20, ...ascii("ftyp"), ...ascii("avif")]);

test("recognises the four permitted image formats", () => {
  assert.equal(detectImageType(PNG), "image/png");
  assert.equal(detectImageType(JPEG), "image/jpeg");
  assert.equal(detectImageType(WEBP), "image/webp");
  assert.equal(detectImageType(AVIF), "image/avif");
});

test("every detected type is on the allow list", () => {
  for (const sample of [PNG, JPEG, WEBP, AVIF]) {
    assert.ok(ALLOWED_IMAGE_TYPES.includes(detectImageType(sample)));
  }
});

test("rejects SVG even though browsers call it an image", () => {
  // SVG 是可內嵌 JavaScript 的 XML 文件，直接當圖片提供會造成跨站指令碼風險。
  const svg = bytesOf(ascii('<svg xmlns="http://www.w3.org/2000/svg">'));

  assert.equal(detectImageType(svg), null);
});

test("rejects plain text, html and empty input", () => {
  assert.equal(detectImageType(bytesOf(ascii("hello world, not an image"))), null);
  assert.equal(detectImageType(bytesOf(ascii("<!doctype html><html></html>"))), null);
  assert.equal(detectImageType(new Uint8Array(0)), null);
  assert.equal(detectImageType(null), null);
});

test("rejects input too short to identify", () => {
  assert.equal(detectImageType(new Uint8Array([0x89, 0x50, 0x4e])), null);
});

test("a renamed text file is still rejected regardless of its extension", () => {
  // 這正是不能信任副檔名的理由：內容才是判斷依據。
  const disguised = bytesOf(ascii("GIF89a this pretends to be an image"));

  assert.equal(detectImageType(disguised), null);
});

test("RIFF containers that are not WebP are rejected", () => {
  // RIFF 也用於 WAV 等格式，必須連同 WEBP 標記一起檢查。
  const wav = bytesOf([...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WAVE")]);

  assert.equal(detectImageType(wav), null);
});

test("ftyp containers that are not AVIF are rejected", () => {
  const mp4 = bytesOf([0x00, 0x00, 0x00, 0x20, ...ascii("ftyp"), ...ascii("mp42")]);

  assert.equal(detectImageType(mp4), null);
});

test("object keys are random and carry the right extension", () => {
  const first = createObjectKey("image/png");
  const second = createObjectKey("image/png");

  assert.notEqual(first, second, "每次產生的名稱必須不同");
  assert.ok(first.endsWith(".png"));
  assert.ok(createObjectKey("image/jpeg").endsWith(".jpg"));
  assert.ok(createObjectKey("image/webp").endsWith(".webp"));
  assert.ok(createObjectKey("image/avif").endsWith(".avif"));
});

test("generated keys pass their own validation", () => {
  for (const type of ALLOWED_IMAGE_TYPES) {
    assert.ok(isValidObjectKey(createObjectKey(type)), type);
  }
});

test("object key validation blocks traversal and unexpected shapes", () => {
  const rejected = [
    "../secret.png",
    "../../etc/passwd",
    "nested/path.png",
    "not-a-uuid.png",
    "1234.png",
    "",
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301.svg",
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301.png/../x",
  ];

  for (const key of rejected) {
    assert.equal(isValidObjectKey(key), false, `應拒絕 ${key}`);
  }
});

test("size limit is exactly 5 MiB", () => {
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
});

test("unknown content types fall back to a neutral extension", () => {
  assert.equal(extensionFor("application/octet-stream"), "bin");
});
