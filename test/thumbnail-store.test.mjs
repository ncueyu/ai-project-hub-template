/**
 * CLI 分段上傳縮圖（2026-08-30，方案 B 階段 4）。
 *
 * 這條路徑與後台上傳是**兩套不同的寫入機制**，不能互相代驗：
 *   - Worker 端用 `.bind()` 傳位元組，參數不佔 SQL 語句長度。
 *   - CLI 端只能把位元組寫成 `X'...'` 十六進位字面值，長度立刻變兩倍，
 *     而 D1 的單一敘述上限是 100 KB。
 *
 * 所以這裡測的全部是「只在 CLI 這一側才會出錯」的東西：十六進位轉換、
 * 分段數、語句長度天花板、以及 DELETE 必須排在 INSERT 之前。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_IMAGE_BYTES, THUMBNAIL_CHUNK_BYTES } from "../src/images.js";
import { buildStoreThumbnailSql, parseOwnKey, toHexLiteral } from "../tools/thumbnail-store.mjs";

const KEY = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
const NOW = "2026-08-30T00:00:00.000Z";

test("toHexLiteral 每個位元組固定兩位、補零、大寫", () => {
  assert.equal(toHexLiteral(new Uint8Array([0, 1, 15, 16, 255])), "00010F10FF");
  assert.equal(toHexLiteral(new Uint8Array([])), "");

  // 長度必須恰好是兩倍——少補一個零，之後的位元組會整串位移，
  // 而 SQLite 只會抱怨「奇數長度」，不會告訴你是哪裡少了。
  const bytes = new Uint8Array(256).map((_, index) => index);

  assert.equal(toHexLiteral(bytes).length, 512);
});

test("分段數是位元組數除以段長無條件進位", () => {
  const cases = [
    [1, 1],
    [THUMBNAIL_CHUNK_BYTES, 1],
    [THUMBNAIL_CHUNK_BYTES + 1, 2],
    [THUMBNAIL_CHUNK_BYTES * 3, 3],
  ];

  for (const [size, expected] of cases) {
    const built = buildStoreThumbnailSql({
      objectKey: KEY,
      contentType: "image/png",
      bytes: new Uint8Array(size),
      now: NOW,
    });

    assert.equal(built.chunkCount, expected, `${size} 位元組應該分成 ${expected} 段`);
  }
});

test("所有段落接回來就是原本的位元組", () => {
  const bytes = new Uint8Array(THUMBNAIL_CHUNK_BYTES * 2 + 123);

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (i * 7 + 3) % 256;
  }

  const built = buildStoreThumbnailSql({ objectKey: KEY, contentType: "image/png", bytes, now: NOW });

  // 從 SQL 文字裡把每一段的十六進位挖回來，證明「寫進去的」與「原檔」一致。
  const hexes = [...built.sql.matchAll(/X'([0-9A-F]*)'/g)].map((match) => match[1]);

  assert.equal(hexes.length, built.chunkCount);
  assert.equal(hexes.join(""), toHexLiteral(bytes));
});

test("最長的敘述不會逼近 D1 的 100 KB 上限", () => {
  /*
   * 這條測試釘住的是 THUMBNAIL_CHUNK_BYTES 與 D1 上限之間的關係。
   * 有人把段長調大時，這裡會先紅，而不是等到使用者上傳一張大圖、
   * 讓 wrangler 丟出一句看不懂的錯誤。
   */
  const built = buildStoreThumbnailSql({
    objectKey: KEY,
    contentType: "image/png",
    bytes: new Uint8Array(MAX_IMAGE_BYTES),
    now: NOW,
  });

  assert.ok(
    built.longestStatement < 95_000,
    `最長敘述 ${built.longestStatement} 位元組，已逼近 D1 的 100 KB 上限`,
  );
});

test("1 MB 的圖分成 26 段", () => {
  // 1 MiB ÷ 40 KiB = 25.6，進位後是 26。這個數字被寫進 migration 0004 的
  // 註解與工作紀錄裡，改動段長時要一起改。
  const built = buildStoreThumbnailSql({
    objectKey: KEY,
    contentType: "image/png",
    bytes: new Uint8Array(MAX_IMAGE_BYTES),
    now: NOW,
  });

  assert.equal(built.chunkCount, 26);
});

test("DELETE 必須排在 INSERT 之前，且先刪段落再刪中介資料", () => {
  /*
   * 順序錯了不會有錯誤訊息，但後果很具體：新圖比舊圖少幾段時，
   * 舊圖的尾段會殘留，讀取端接出一個比宣告長度更長的檔案。
   */
  const built = buildStoreThumbnailSql({
    objectKey: KEY,
    contentType: "image/png",
    bytes: new Uint8Array(10),
    now: NOW,
  });

  const lines = built.sql.trim().split("\n");

  assert.match(lines[0], /^DELETE FROM thumbnail_chunks/);
  assert.match(lines[1], /^DELETE FROM thumbnail_blobs/);
  assert.match(lines[2], /^INSERT INTO thumbnail_blobs/);
  assert.match(lines[3], /^INSERT INTO thumbnail_chunks/);
});

test("中介資料記下來的 byte_size 與 chunk_count 與實際內容一致", () => {
  const bytes = new Uint8Array(THUMBNAIL_CHUNK_BYTES + 7);
  const built = buildStoreThumbnailSql({
    objectKey: KEY,
    contentType: "image/webp",
    bytes,
    now: NOW,
  });

  // 讀取端會拿這兩個數字驗證還原結果；寫錯的話每次讀都會回 null，
  // 而畫面上只是「縮圖不見了」。
  assert.ok(built.sql.includes(`'image/webp', ${bytes.length}, ${built.chunkCount}`));
});

test("object_key 與時間都經過跳脫，單引號不會逃出字面值", () => {
  const built = buildStoreThumbnailSql({
    objectKey: "it's.png",
    contentType: "image/png",
    bytes: new Uint8Array(1),
    now: NOW,
  });

  assert.ok(built.sql.includes("'it''s.png'"));
});

test("parseOwnKey 與 Worker 端同一套規則：只認自己存的路徑", () => {
  assert.equal(parseOwnKey(`/media/thumbnails/${KEY}`), KEY);

  // 舊制靜態檔、外部網址、路徑穿越、形狀不合法——全部不可被當成孤兒刪掉。
  assert.equal(parseOwnKey("/thumbnails/old.png"), null);
  assert.equal(parseOwnKey("https://example.com/a.png"), null);
  assert.equal(parseOwnKey("/media/thumbnails/../../etc/passwd"), null);
  assert.equal(parseOwnKey("/media/thumbnails/not-a-uuid.png"), null);
  assert.equal(parseOwnKey(`/media/thumbnails/${KEY.replace(".png", ".svg")}`), null);
  assert.equal(parseOwnKey(null), null);
  assert.equal(parseOwnKey(undefined), null);
  assert.equal(parseOwnKey(""), null);
});
