-- Migration 0004：縮圖改存 D1（方案 B）
--
-- 依據：2026-08-30-工作計畫-縮圖與外部連結專案.md 階段 2。
--
-- ## 為什麼縮圖要進資料庫
--
-- 原本縮圖是展示中心的靜態檔案（public/thumbnails/）。那代表兩件事：
--   1. 後台的「上傳圖片」按鈕做不到——瀏覽器寫不了伺服器的檔案系統，
--      所以那個按鈕一直回 503。不用 CLI 的人完全沒有辦法設縮圖。
--   2. 每加一張縮圖都要重新部署展示中心才會上線。而後台其他設定都是
--      即時生效的，使用者沒有理由預期縮圖是例外——這是「以為存好了、
--      其實還沒生效」那一類最容易誤解的狀況。
--
-- 原本的替代方案是 R2，但 R2 即使用免費額度也要綁信用卡（使用者已實測），
-- 因此改用已經在用的 D1。D1 不需要另外綁卡——這個展示中心的專案、分類、
-- 設定本來就存在裡面。
--
-- ## 為什麼要分段
--
-- D1 的**單一 SQL 語句上限是 100 KB**
-- （https://developers.cloudflare.com/d1/platform/limits）。
--
-- Worker 端沒問題，它用 .bind() 傳參數、參數不算進語句長度。但 CLI 端
-- （`hub thumbnail`）是把 SQL **文字**交給 `wrangler d1 execute`，一張圖
-- 轉成十六進位字面值是原始大小的兩倍，一句 INSERT 立刻爆掉。
--
-- 所以圖片切成固定大小的段落，一段一列。上限 1 MB（src/images.js 的
-- MAX_IMAGE_BYTES）搭配 40 KiB 的段落大小，最多 26 段，每段的十六進位字面值
-- 約 82 KB，安全落在 100 KB 以內。
--
-- ## 為什麼用 BLOB 而不是 base64 文字
--
-- 兩條寫入路徑都能產生真正的位元組：Worker 直接 bind ArrayBuffer，
-- CLI 寫 X'...' 十六進位字面值。讀取端因此拿到的就是 ArrayBuffer，
-- 不需要在 Worker 裡解 base64——少一層轉換，也少一個會出錯的地方。
--
-- ## 為什麼拆成兩張表
--
-- 中繼資料（型別、大小、段數）獨立一列，讀取時先拿它就能決定
-- Content-Type 與 Content-Length，並且驗證段數是否完整——
-- 少一段的圖片應該回 404，而不是送出一張破圖。

CREATE TABLE thumbnail_blobs (
  -- 與 R2 時期相同的物件名稱形狀（<uuid>.<副檔名>），沿用 src/images.js 的
  -- isValidObjectKey() 驗證。用 UUID 而不是專案代稱，是為了不讓網址洩漏
  -- 專案的識別資訊，也讓同一個專案換圖時舊網址自然失效。
  object_key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/avif')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE thumbnail_chunks (
  object_key TEXT NOT NULL
    REFERENCES thumbnail_blobs (object_key) ON DELETE CASCADE,
  -- 從 0 開始。讀取時 ORDER BY seq 接回原始位元組。
  seq INTEGER NOT NULL CHECK (seq >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY (object_key, seq)
);

-- 讀取一張圖是「拿某個 object_key 的所有段落、依序排好」，複合主鍵
-- (object_key, seq) 本身就是這個查詢的索引，不需要額外建立。
