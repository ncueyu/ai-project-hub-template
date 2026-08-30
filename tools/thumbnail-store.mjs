// @ts-check

/**
 * 從命令列把縮圖存進 D1（2026-08-30，方案 B 階段 4）。
 *
 * 這條路徑存在的理由是「AI 截了圖，要把它放進展示中心」。走 CLI 而不是後台
 * API 的關鍵好處是**完全不需要後台密碼**——`wrangler` 用的是使用者電腦上
 * 已經有的 Cloudflare 憑證，與 `AGENTS.md` 第 6 節「密碼不經過 AI」相容。
 *
 * ## 為什麼要自己組 SQL 而不是重用 Worker 那一套
 *
 * Worker 端用 `.bind()` 傳位元組，參數不算進 SQL 語句長度。CLI 端沒有這個
 * 管道——`wrangler d1 execute` 收的是 SQL **文字**，位元組只能寫成
 * `X'...'` 十六進位字面值，長度立刻變成兩倍。D1 的單一語句上限是 100 KB，
 * 所以圖片必須切段（見 migration 0004）。
 *
 * ## 為什麼寫成 .sql 檔而不是 --command
 *
 * 26 段的總長度是 MB 等級，遠超過作業系統對單一命令列參數的限制。
 */

import { randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, THUMBNAIL_CHUNK_BYTES, detectImageType, extensionFor } from "../src/images.js";
import { executeSql, executeSqlFile, sqlLiteral } from "./d1.mjs";

/**
 * 超過上限時要說的話。
 *
 * 與 `src/routes/thumbnails.js` 的 TOO_LARGE_HINT 是同一段話的兩份拷貝——
 * 前端與 CLI 沒有共用的模組（一邊跑在 Worker、一邊跑在 Node），刻意重複
 * 而不是為了去重造一個共用層。**改一邊就要改另一邊。**
 *
 * @param {number} bytes
 * @returns {string}
 */
function tooLargeMessage(bytes) {
  const mb = (bytes / 1024 / 1024).toFixed(1);

  return (
    `這張圖 ${mb} MB，超過 1 MB 的上限。縮圖只是卡片上的一小塊，不需要原始解析度——\n`
    + "用「小畫家」開啟圖片 →「重新調整大小」→ 改成 50%，通常就會降到 300 KB 以內。"
  );
}

/**
 * 把位元組轉成 SQL 的十六進位字面值內容（不含 X'' 外框）。
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHexLiteral(bytes) {
  let out = "";

  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }

  return out.toUpperCase();
}

/**
 * 產生把一張圖寫進 D1 的完整 SQL。
 *
 * 順序是刻意的：先刪舊段落再插入，避免「新圖比舊圖少幾段」時殘留尾段——
 * 那會讓讀取端接出一個比宣告長度更長的檔案。與 Worker 端 `putThumbnail()`
 * 的做法一致。
 *
 * @param {{ objectKey: string, contentType: string, bytes: Uint8Array, now: string }} input
 * @returns {{ sql: string, chunkCount: number, longestStatement: number }}
 */
export function buildStoreThumbnailSql(input) {
  const statements = [];

  statements.push(
    `DELETE FROM thumbnail_chunks WHERE object_key = ${sqlLiteral(input.objectKey)};`,
    `DELETE FROM thumbnail_blobs WHERE object_key = ${sqlLiteral(input.objectKey)};`,
  );

  const chunkCount = Math.ceil(input.bytes.length / THUMBNAIL_CHUNK_BYTES);

  statements.push(
    "INSERT INTO thumbnail_blobs (object_key, content_type, byte_size, chunk_count, created_at) VALUES ("
      + [
        sqlLiteral(input.objectKey),
        sqlLiteral(input.contentType),
        String(input.bytes.length),
        String(chunkCount),
        sqlLiteral(input.now),
      ].join(", ")
      + ");",
  );

  for (let seq = 0; seq < chunkCount; seq += 1) {
    const start = seq * THUMBNAIL_CHUNK_BYTES;
    const chunk = input.bytes.subarray(start, Math.min(start + THUMBNAIL_CHUNK_BYTES, input.bytes.length));

    statements.push(
      `INSERT INTO thumbnail_chunks (object_key, seq, data) VALUES (${sqlLiteral(input.objectKey)}, ${seq}, X'${toHexLiteral(chunk)}');`,
    );
  }

  return {
    sql: `${statements.join("\n")}\n`,
    chunkCount,
    longestStatement: statements.reduce((max, statement) => Math.max(max, statement.length), 0),
  };
}

/**
 * 讀檔、驗證、寫進 D1，並把專案的 `thumbnail_url` 指過去。
 *
 * @param {{
 *   imagePath: string,
 *   projectId: number,
 *   previousThumbnailUrl?: string | null,
 *   remote?: boolean,
 *   now?: string,
 *   executeSql?: typeof executeSql,
 *   executeSqlFile?: typeof executeSqlFile,
 * }} options
 * @returns {Promise<{ thumbnailUrl: string, chunkCount: number, byteSize: number, contentType: string }>}
 */
export async function storeThumbnailFromFile(options) {
  const executeSqlFn = options.executeSql ?? executeSql;
  const executeSqlFileFn = options.executeSqlFile ?? executeSqlFile;
  const now = options.now ?? new Date().toISOString();

  const stats = statSync(options.imagePath);

  if (stats.size > MAX_IMAGE_BYTES) {
    throw new Error(tooLargeMessage(stats.size));
  }

  if (stats.size === 0) {
    throw new Error("這個檔案是空的，沒有東西可以當縮圖。");
  }

  const bytes = new Uint8Array(readFileSync(options.imagePath));

  // 只認檔案本身的位元組特徵，不看副檔名——與 Worker 端同一個判斷。
  const contentType = detectImageType(bytes);

  if (!contentType || !ALLOWED_IMAGE_TYPES.includes(contentType)) {
    throw new Error(
      "這個檔案看起來不是 PNG、JPEG、WebP 或 AVIF。\n"
        + "（判斷依據是檔案內容而不是副檔名——把 .txt 改名成 .png 是不行的。）",
    );
  }

  const objectKey = `${randomUUID()}.${extensionFor(contentType)}`;
  const built = buildStoreThumbnailSql({ objectKey, contentType, bytes, now });

  /*
   * 防呆：D1 的單一語句上限是 100 KB。THUMBNAIL_CHUNK_BYTES 與
   * MAX_IMAGE_BYTES 的組合本來就算過安全，但那是靠常數維持的——
   * 這裡再擋一次，免得日後有人調大段落大小之後，錯誤變成 wrangler
   * 丟出來的一句看不懂的訊息。
   */
  if (built.longestStatement > 95_000) {
    throw new Error(
      `分段後最長的 SQL 敘述有 ${built.longestStatement} 位元組，逼近 D1 的 100 KB 上限。`
        + "請調小 src/images.js 的 THUMBNAIL_CHUNK_BYTES。",
    );
  }

  const sqlPath = join(tmpdir(), `hub-thumbnail-${objectKey}.sql`);

  writeFileSync(sqlPath, built.sql, "utf8");

  try {
    await executeSqlFileFn(sqlPath, { remote: options.remote });
  } finally {
    // 失敗時也刪：那個檔案裡是圖片的十六進位內容，留在暫存目錄沒有意義。
    try {
      unlinkSync(sqlPath);
    } catch {
      /* 刪不掉就算了，作業系統會自己清暫存目錄 */
    }
  }

  const thumbnailUrl = `/media/thumbnails/${objectKey}`;

  await executeSqlFn(
    `UPDATE projects SET thumbnail_url = ${sqlLiteral(thumbnailUrl)}, updated_at = ${sqlLiteral(now)} WHERE id = ${sqlLiteral(options.projectId)}`,
    { remote: options.remote },
  );

  /*
   * 換圖之後刪掉舊的位元組，理由與 Worker 端相同：每次上傳都是新的 UUID，
   * 舊圖不會被覆蓋而是變成沒有人指向的孤兒，慢慢吃掉 D1 的配額。
   *
   * 只刪自己管的路徑——舊制的 /thumbnails/xxx.png 靜態檔與使用者手動填的
   * 外部網址都不是這裡存的。
   */
  const previousKey = parseOwnKey(options.previousThumbnailUrl);

  if (previousKey !== null && previousKey !== objectKey) {
    try {
      await executeSqlFn(
        `DELETE FROM thumbnail_chunks WHERE object_key = ${sqlLiteral(previousKey)};`,
        { remote: options.remote },
      );
      await executeSqlFn(
        `DELETE FROM thumbnail_blobs WHERE object_key = ${sqlLiteral(previousKey)};`,
        { remote: options.remote },
      );
    } catch {
      // 刪不掉只是留下孤兒資料，不該讓已經成功的上傳變成失敗。
    }
  }

  return { thumbnailUrl, chunkCount: built.chunkCount, byteSize: bytes.length, contentType };
}

/**
 * 與 `src/routes/thumbnails.js` 的 `parseOwnThumbnailKey()` 同一套規則。
 * 兩邊分別跑在 Node 與 Worker，沒有共用模組，改一邊要改另一邊。
 *
 * @param {unknown} thumbnailUrl
 * @returns {string | null}
 */
export function parseOwnKey(thumbnailUrl) {
  if (typeof thumbnailUrl !== "string") {
    return null;
  }

  const prefix = "/media/thumbnails/";

  if (!thumbnailUrl.startsWith(prefix)) {
    return null;
  }

  const key = thumbnailUrl.slice(prefix.length);

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|avif)$/.test(key)
    ? key
    : null;
}
