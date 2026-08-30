-- Migration 0001: AI Project Hub metadata schema
--
-- 依據：2026-08-12-階段二詳細工作計畫.md 第 9 節「D1 Schema 完整契約」。
-- 本檔案只建立結構與限制，不包含任何 Seed 測試資料（第 9.7 節規定）。
-- 建立順序依外鍵相依性：先建被參考的資料表，再建參考它們的資料表。

-- ---------------------------------------------------------------------------
-- 9.2 categories
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 9.3 tags
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 9.1 projects
--
-- visibility 只允許五種固定狀態，由 CHECK 在資料庫層強制。
-- category_id 在分類被刪除時設為 NULL，不連帶刪除專案。
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL
    CHECK (visibility IN ('public', 'unlisted', 'password', 'private', 'disabled')),
  category_id INTEGER NULL
    REFERENCES categories (id) ON DELETE SET NULL,
  repository_url TEXT NULL,
  worker_name TEXT NULL,
  platform TEXT NOT NULL
    CHECK (platform IN ('cloudflare', 'vercel', 'supabase', 'external')),
  deployment_url TEXT NULL,
  project_type TEXT NOT NULL
    CHECK (project_type IN ('static', 'worker', 'fullstack', 'other')),
  database_type TEXT NOT NULL DEFAULT 'none'
    CHECK (database_type IN ('none', 'd1', 'supabase', 'other')),
  thumbnail_url TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_deployed_at TEXT NULL
);

CREATE INDEX idx_projects_visibility_updated
  ON projects (visibility, updated_at DESC);

CREATE INDEX idx_projects_category
  ON projects (category_id);

-- ---------------------------------------------------------------------------
-- 9.4 project_tags（多對多關聯）
-- ---------------------------------------------------------------------------
CREATE TABLE project_tags (
  project_id INTEGER NOT NULL
    REFERENCES projects (id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL
    REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- 9.5 project_policies
--
-- 本表是 Password Hash 與 Policy Version 的唯一資料來源。
-- password_hash 只儲存 PBKDF2 編碼結果，格式固定為：
--   pbkdf2-sha256$<iterations>$<base64-salt>$<base64-derived-key>
-- 明碼密碼一律不進資料庫。
-- production iterations 不在本 Migration 決定（需經 Worker 實測後定案）。
-- ---------------------------------------------------------------------------
CREATE TABLE project_policies (
  project_id INTEGER PRIMARY KEY
    REFERENCES projects (id) ON DELETE CASCADE,
  policy_version INTEGER NOT NULL DEFAULT 1
    CHECK (policy_version >= 1),
  password_hash TEXT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 9.6 deployments
-- ---------------------------------------------------------------------------
CREATE TABLE deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL
    REFERENCES projects (id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  deployment_url TEXT NOT NULL,
  version_ref TEXT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('success', 'failed', 'rolled_back', 'unknown'))
);

CREATE INDEX idx_deployments_project_created
  ON deployments (project_id, created_at DESC);
