-- Migration 0002: 推薦連結（links）與站台設定（site_settings）
--
-- 依據：2026-08-27-工作計畫.md 第三節資料表設計。
--
-- links 為什麼獨立於 projects（不是塞進同一張表加一個 type 欄位）：
--   連結沒有 repo、不需要部署、不套用五態 visibility 與密碼閘道——
--   混進 projects 會讓每一條既有的權限查詢（GALLERY_LISTED_STATES、
--   五態 CHECK、Access Gate 的 run_worker_first 判斷）都要為「這其實
--   不是專案」的例外分支特例處理。外部連結的「要不要顯示」只有兩態，
--   因此改用獨立的 is_listed 布林旗標，不套用 visibility 的五態 CHECK。
--
-- category_id 的刪除語意與 projects 對 categories 的做法完全相同：
--   刪掉分類不刪連結，只讓連結變成未分類（ON DELETE SET NULL）。
--
-- site_settings 為什麼做成 key-value 而不是單列多欄：
--   本次只用 gallery_layout 一個鍵，但下一個主線項目（站名設定，
--   缺口盤點優先順位 3）也需要站台層級設定；key-value 讓那時只需要
--   多加一列資料，不必再修改 schema、也不必再新建一張表。

-- ---------------------------------------------------------------------------
-- links
-- ---------------------------------------------------------------------------
CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NULL
    REFERENCES categories (id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_listed INTEGER NOT NULL DEFAULT 1
    CHECK (is_listed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_links_category
  ON links (category_id);

-- 公開查詢固定用「WHERE is_listed = 1 ORDER BY sort_order, name」，
-- 這個索引涵蓋過濾與排序兩者，與 0001 的 idx_projects_visibility_updated
-- 是同一種「過濾欄位＋排序欄位」複合索引慣例。
CREATE INDEX idx_links_listed_sort
  ON links (is_listed, sort_order, name);

-- ---------------------------------------------------------------------------
-- site_settings
-- ---------------------------------------------------------------------------
CREATE TABLE site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
