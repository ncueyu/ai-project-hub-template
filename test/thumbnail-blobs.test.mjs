/**
 * 縮圖的 D1 分段存取（2026-08-30，方案 B）。
 *
 * 這一層最容易出錯的不是「存得進去」，而是**殘缺的資料被當成好的送出去**：
 * 少一段、長度對不上、覆寫時殘留舊尾段——三者都會產生一張破圖，而瀏覽器
 * 只會顯示一個裂掉的圖示，使用者無從得知問題在哪。所以這裡的重點測試都在
 * 「壞掉的時候要回 null」，而不是在快樂路徑。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { THUMBNAIL_CHUNK_BYTES } from "../src/images.js";
import {
  deleteThumbnail,
  getThumbnail,
  putThumbnail,
  splitIntoChunks,
} from "../src/repositories/thumbnails.js";

const NOW = "2026-08-30T00:00:00.000Z";
const KEY = "11111111-2222-3333-4444-555555555555.png";

/**
 * 用 Map 當儲存後端的假 D1。只實作這一層真的會用到的介面。
 */
function createFakeDb() {
  /** @type {Map<string, { content_type: string, byte_size: number, chunk_count: number }>} */
  const blobs = new Map();
  /** @type {{ key: string, seq: number, data: Uint8Array }[]} */
  let chunks = [];

  const run = (sql, params) => {
    if (sql.includes("INSERT INTO thumbnail_blobs")) {
      const [object_key, content_type, byte_size, chunk_count] = params;
      blobs.set(object_key, { content_type, byte_size, chunk_count });
      return { results: [] };
    }

    if (sql.includes("DELETE FROM thumbnail_chunks")) {
      chunks = chunks.filter((chunk) => chunk.key !== params[0]);
      return { results: [] };
    }

    if (sql.includes("DELETE FROM thumbnail_blobs")) {
      blobs.delete(params[0]);
      return { results: [] };
    }

    if (sql.includes("INSERT INTO thumbnail_chunks")) {
      chunks.push({ key: params[0], seq: params[1], data: params[2] });
      return { results: [] };
    }

    if (sql.includes("FROM thumbnail_blobs")) {
      return { first: blobs.get(params[0]) ?? null };
    }

    if (sql.includes("FROM thumbnail_chunks")) {
      const rows = chunks
        .filter((chunk) => chunk.key === params[0])
        .sort((a, b) => a.seq - b.seq)
        .map((chunk) => ({ data: chunk.data }));

      return { results: rows };
    }

    throw new Error(`假資料庫沒有處理這句 SQL：${sql}`);
  };

  return {
    blobs,
    getChunks: () => chunks,
    corruptByDroppingLastChunk() {
      chunks = chunks.slice(0, -1);
    },
    prepare(sql) {
      let bound = [];

      return {
        bind(...params) {
          bound = params;
          return this;
        },
        async first() {
          return run(sql, bound).first ?? null;
        },
        async all() {
          return { results: run(sql, bound).results ?? [] };
        },
        async run() {
          return run(sql, bound);
        },
        _sql: sql,
        _bound: () => bound,
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        await statement.run();
      }
      return statements.map(() => ({ results: [] }));
    },
  };
}

/** @param {number} size */
function makeBytes(size) {
  const bytes = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    bytes[i] = i % 256;
  }

  return bytes;
}

test("splitIntoChunks：剛好整除、有餘數、空輸入", () => {
  assert.equal(splitIntoChunks(makeBytes(100), 10).length, 10);
  assert.equal(splitIntoChunks(makeBytes(105), 10).length, 11);
  assert.deepEqual(splitIntoChunks(new Uint8Array(0)), []);

  const last = splitIntoChunks(makeBytes(105), 10).at(-1);
  assert.equal(last.length, 5, "最後一段只該有餘數的長度");
});

test("存進去再讀出來，位元組完全一樣", async () => {
  const db = createFakeDb();
  // 刻意跨越多段，單段測不到接合的邏輯。
  const bytes = makeBytes(THUMBNAIL_CHUNK_BYTES * 2 + 123);

  const written = await putThumbnail(db, { objectKey: KEY, contentType: "image/png", bytes, now: NOW });

  assert.equal(written.chunkCount, 3);
  assert.equal(written.byteSize, bytes.length);

  const read = await getThumbnail(db, KEY);

  assert.equal(read.contentType, "image/png");
  assert.deepEqual(read.bytes, bytes);
});

test("找不到的 key 回 null，不是丟例外", async () => {
  assert.equal(await getThumbnail(createFakeDb(), KEY), null);
});

test("段落殘缺時回 null，不送出半張圖", async () => {
  /*
   * 這是本檔最重要的一條。少一段而照樣回傳的話，瀏覽器會拿到一個宣稱是 PNG
   * 但解不開的檔案，畫面上只有一個裂掉的圖示——使用者完全看不出是資料壞了。
   * 回 null（上層轉成 404）至少是一個明確的狀態。
   */
  const db = createFakeDb();
  const bytes = makeBytes(THUMBNAIL_CHUNK_BYTES * 2);

  await putThumbnail(db, { objectKey: KEY, contentType: "image/png", bytes, now: NOW });
  db.corruptByDroppingLastChunk();

  assert.equal(await getThumbnail(db, KEY), null);
});

test("覆寫同一個 key 時不會殘留舊的尾段", async () => {
  /*
   * 新圖比舊圖少幾段的時候，殘留的尾段會讓接出來的位元組比宣告的長度更長。
   * putThumbnail 在寫入前先 DELETE 就是為了這個。
   */
  const db = createFakeDb();

  await putThumbnail(db, {
    objectKey: KEY,
    contentType: "image/png",
    bytes: makeBytes(THUMBNAIL_CHUNK_BYTES * 3),
    now: NOW,
  });

  const smaller = makeBytes(THUMBNAIL_CHUNK_BYTES);

  await putThumbnail(db, { objectKey: KEY, contentType: "image/webp", bytes: smaller, now: NOW });

  assert.equal(db.getChunks().length, 1, "舊的兩段應該被清掉");

  const read = await getThumbnail(db, KEY);

  assert.deepEqual(read.bytes, smaller);
  assert.equal(read.contentType, "image/webp");
});

test("空的圖片直接拒絕，不寫出一列讀不出東西的中繼資料", async () => {
  await assert.rejects(
    putThumbnail(createFakeDb(), {
      objectKey: KEY,
      contentType: "image/png",
      bytes: new Uint8Array(0),
      now: NOW,
    }),
  );
});

test("刪除後讀不到", async () => {
  const db = createFakeDb();

  await putThumbnail(db, { objectKey: KEY, contentType: "image/png", bytes: makeBytes(50), now: NOW });
  await deleteThumbnail(db, KEY);

  assert.equal(await getThumbnail(db, KEY), null);
  assert.equal(db.getChunks().length, 0);
});
