/**
 * 後台上傳縮圖（2026-08-30，方案 B 階段 3）。
 *
 * 這個按鈕在 2026-08-30 之前一直回 503：它需要 R2，而 R2 即使用免費額度也
 * 要綁信用卡，那個綁定從來沒啟用過。也就是說**不使用 CLI 的人一直沒有辦法
 * 設縮圖**。改存 D1 之後才真的能用。
 *
 * 測試的重點放在兩件前端完全看不出來的事：
 *   1. 換圖之後舊的位元組有沒有被清掉（不清會慢慢吃掉 D1 的 500 MB 配額）
 *   2. 「不是自己存的」縮圖網址不可以被當成孤兒刪掉
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseOwnThumbnailKey } from "../src/routes/thumbnails.js";

const KEY = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";

test("parseOwnThumbnailKey 只認自己管的 /media/thumbnails/ 路徑", () => {
  assert.equal(parseOwnThumbnailKey(`/media/thumbnails/${KEY}`), KEY);
});

test("parseOwnThumbnailKey 對不是自己存的東西一律回 null", () => {
  /*
   * 這一條守的是「刪錯東西」。thumbnail_url 可能是：
   *   - 舊制的靜態檔（hub ship 搬進 public/thumbnails/）
   *   - 使用者手動填的外部網址
   *   - 空的或格式不對的值
   * 這些都不是這個路由存的，去刪只會刪錯或刪不到，而且不會有人發現。
   */
  const notOurs = [
    "/thumbnails/exam-quiz.png", // 舊制靜態檔
    "https://example.com/pic.png", // 外部網址
    "/media/thumbnails/../secret", // 路徑穿越嘗試
    "/media/thumbnails/not-a-uuid.png", // 形狀不合法
    "/media/thumbnails/", // 空的 key
    "",
    null,
    undefined,
    42,
  ];

  for (const value of notOurs) {
    assert.equal(parseOwnThumbnailKey(value), null, `不該認得：${String(value)}`);
  }
});

test("parseOwnThumbnailKey 認得四種允許的副檔名，其餘不認", () => {
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  for (const ext of ["png", "jpg", "webp", "avif"]) {
    assert.equal(parseOwnThumbnailKey(`/media/thumbnails/${uuid}.${ext}`), `${uuid}.${ext}`);
  }

  // svg 刻意不在允許清單裡：SVG 是可以帶 JavaScript 的 XML 文件，
  // 當成圖片直接提供會造成跨站指令碼風險（見 src/images.js 檔頭）。
  for (const ext of ["svg", "gif", "html"]) {
    assert.equal(parseOwnThumbnailKey(`/media/thumbnails/${uuid}.${ext}`), null, ext);
  }
});
