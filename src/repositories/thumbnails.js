// @ts-check

/**
 * 縮圖的 D1 存取層（2026-08-30，方案 B）。
 *
 * 圖片切成固定大小的段落存進 `thumbnail_chunks`，中繼資料另外一列在
 * `thumbnail_blobs`。分段的理由見 migration 0004 的檔頭：D1 的單一 SQL
 * 語句上限是 100 KB，而 CLI 端是把 SQL 文字送出去的。
 *
 * 這一層刻意只做「位元組進、位元組出」，不碰 MIME 偵測與大小檢查——
 * 那些是 `src/images.js` 的責任，呼叫端要先驗過再進來。
 */

import { THUMBNAIL_CHUNK_BYTES } from "../images.js";

/**
 * 把位元組切成固定大小的段落。
 *
 * @param {Uint8Array} bytes
 * @param {number} [chunkSize]
 * @returns {Uint8Array[]}
 */
export function splitIntoChunks(bytes, chunkSize = THUMBNAIL_CHUNK_BYTES) {
  if (bytes.length === 0) {
    return [];
  }

  const chunks = [];

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    // subarray 不複製底層記憶體；D1 的 bind 會自己讀出需要的範圍。
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }

  return chunks;
}

/**
 * 寫入一張縮圖。
 *
 * 用 `db.batch()` 讓中繼資料與所有段落在同一個交易裡完成——中途失敗會留下
 * 「有中繼資料、段落不全」的圖片，而那種圖片讀出來是破的，比完全沒有更糟。
 *
 * @param {D1Database} db
 * @param {{ objectKey: string, contentType: string, bytes: Uint8Array, now: string }} input
 * @returns {Promise<{ objectKey: string, chunkCount: number, byteSize: number }>}
 */
export async function putThumbnail(db, input) {
  const chunks = splitIntoChunks(input.bytes);

  if (chunks.length === 0) {
    throw new Error("縮圖沒有任何內容，不寫入。");
  }

  const statements = [
    db
      .prepare(
        `INSERT INTO thumbnail_blobs (object_key, content_type, byte_size, chunk_count, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(object_key) DO UPDATE SET
           content_type = excluded.content_type,
           byte_size = excluded.byte_size,
           chunk_count = excluded.chunk_count,
           created_at = excluded.created_at`,
      )
      .bind(input.objectKey, input.contentType, input.bytes.length, chunks.length, input.now),
    // 覆寫同一個 key 時先清乾淨：新圖比舊圖少幾段的話，殘留的尾段會讓
    // 讀取端接出一個比宣告長度更長的檔案。
    db.prepare("DELETE FROM thumbnail_chunks WHERE object_key = ?").bind(input.objectKey),
    ...chunks.map((chunk, seq) =>
      db
        .prepare("INSERT INTO thumbnail_chunks (object_key, seq, data) VALUES (?, ?, ?)")
        .bind(input.objectKey, seq, chunk),
    ),
  ];

  await db.batch(statements);

  return { objectKey: input.objectKey, chunkCount: chunks.length, byteSize: input.bytes.length };
}

/**
 * 讀出一張縮圖。
 *
 * 段落數與宣告的 `chunk_count` 不符時回 `null`（當成找不到），而不是把
 * 殘缺的位元組送出去——瀏覽器拿到半張圖只會顯示一塊破圖，使用者無從得知
 * 問題出在哪。回 404 至少是一個明確的狀態。
 *
 * @param {D1Database} db
 * @param {string} objectKey
 * @returns {Promise<{ bytes: Uint8Array, contentType: string } | null>}
 */
export async function getThumbnail(db, objectKey) {
  const meta = await db
    .prepare("SELECT content_type, byte_size, chunk_count FROM thumbnail_blobs WHERE object_key = ?")
    .bind(objectKey)
    .first();

  if (!meta) {
    return null;
  }

  // 一次查詢取回所有段落。D1 免費方案每次 Worker 呼叫上限 50 個查詢，
  // 逐段查會在 25 段時就吃掉一半的額度。
  const rows = await db
    .prepare("SELECT data FROM thumbnail_chunks WHERE object_key = ? ORDER BY seq ASC")
    .bind(objectKey)
    .all();

  const chunks = (rows.results ?? []).map((row) => toUint8Array(row.data));

  if (chunks.length !== Number(meta.chunk_count)) {
    return null;
  }

  const bytes = concat(chunks, Number(meta.byte_size));

  if (bytes === null) {
    return null;
  }

  return { bytes, contentType: String(meta.content_type) };
}

/**
 * 刪除一張縮圖。段落靠外鍵的 ON DELETE CASCADE 一起清掉。
 *
 * @param {D1Database} db
 * @param {string} objectKey
 * @returns {Promise<void>}
 */
export async function deleteThumbnail(db, objectKey) {
  await db.batch([
    db.prepare("DELETE FROM thumbnail_chunks WHERE object_key = ?").bind(objectKey),
    db.prepare("DELETE FROM thumbnail_blobs WHERE object_key = ?").bind(objectKey),
  ]);
}

/**
 * D1 的 BLOB 欄位在不同執行環境回傳的形狀不完全一致：Workers 執行期給
 * ArrayBuffer，本機 miniflare 有時給的是一般陣列。統一成 Uint8Array，
 * 讓上層不必分辨。
 *
 * @param {unknown} value
 * @returns {Uint8Array}
 */
function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }

  return new Uint8Array(0);
}

/**
 * 接回原始位元組，並核對總長度。
 *
 * 長度不符時回 null：這代表資料庫裡的中繼資料與實際內容對不起來，
 * 送出去只會是一張破圖。
 *
 * @param {Uint8Array[]} chunks
 * @param {number} expectedSize
 * @returns {Uint8Array | null}
 */
function concat(chunks, expectedSize) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  if (total !== expectedSize) {
    return null;
  }

  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}
