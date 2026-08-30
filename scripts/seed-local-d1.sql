-- 本機開發與階段二整合驗證用的示範資料（Seed）。
--
-- 依 2026-08-12 階段二詳細工作計畫第 31 節，必須涵蓋七種 fixture：
--   A = Public Static      B = Unlisted Static   C = Password Static
--   D = Private            E = Disabled          F = Worker + D1
--   G = Supabase Auth Demo
--
-- 重要：
--   1. 這個檔案**不是** migration，不會被 `wrangler d1 migrations apply` 執行，
--      也絕不可寫入正式資料庫。
--   2. 執行方式（只對本機）：
--        pnpm run seed:local
--   3. 每次執行都會先清空三張主要資料表再重新寫入，可重複執行。

DELETE FROM projects;
DELETE FROM categories;
DELETE FROM tags;

INSERT INTO categories (id, name, slug, description, sort_order, created_at, updated_at) VALUES
  (1, '教學工具', 'teaching', '課堂上直接可用的小工具', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  (2, '學校網站', 'school-site', '科系與活動用的網站', 2, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  (3, '測試中', 'testing', '尚未對外的實驗專案', 3, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

INSERT INTO tags (id, name, slug, created_at, updated_at) VALUES
  (1, '電子', 'electronics', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  (2, '互動', 'interactive', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  (3, '資料庫', 'database', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

-- ---------------------------------------------------------------------------
-- A：Public Static —— 會出現在展示中心
-- ---------------------------------------------------------------------------
INSERT INTO projects (
  id, name, slug, description, visibility, category_id,
  repository_url, worker_name, platform, deployment_url,
  project_type, database_type, thumbnail_url,
  created_at, updated_at, last_deployed_at
) VALUES (
  1, '電阻色碼互動練習', 'resistor-color-code',
  '用滑鼠選色環，立刻算出電阻值與誤差範圍，適合課堂即時練習。',
  'public', 1,
  'https://github.example.test/example-teacher/resistor-color-code', 'resistor-color-code',
  'cloudflare', 'https://resistor-color-code.example.test',
  'static', 'none', NULL,
  '2026-08-02T00:00:00Z', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
);

-- Public Static（第二筆）：故意給一個必定失敗的圖片網址，驗證破圖時的替代顯示
INSERT INTO projects (
  id, name, slug, description, visibility, category_id,
  repository_url, worker_name, platform, deployment_url,
  project_type, database_type, thumbnail_url,
  created_at, updated_at, last_deployed_at
) VALUES (
  2, '電子科招生網站', 'electronics-admission',
  '科系介紹、課程地圖與升學進路，手機與電腦都能閱讀。',
  'public', 2,
  NULL, 'electronics-admission',
  'cloudflare', 'https://electronics-admission.example.test',
  'static', 'none', '/thumbnails/not-found.png',
  '2026-08-03T00:00:00Z', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'
);

-- ---------------------------------------------------------------------------
-- B：Unlisted Static —— 不列在展示中心，知道網址可直接開
-- ---------------------------------------------------------------------------
INSERT INTO projects (
  id, name, slug, description, visibility, category_id,
  platform, deployment_url, project_type, database_type,
  created_at, updated_at
) VALUES (
  3, '段考成績分析表', 'exam-analysis',
  '只分享給同科老師的成績統計工具。',
  'unlisted', 1,
  'cloudflare', 'https://exam-analysis.example.test',
  'static', 'none',
  '2026-08-04T00:00:00Z', '2026-08-08T00:00:00Z'
);

-- ---------------------------------------------------------------------------
-- C：Password Static —— 需要密碼
-- ---------------------------------------------------------------------------
INSERT INTO projects (
  id, name, slug, description, visibility, category_id,
  platform, deployment_url, project_type, database_type,
  created_at, updated_at
) VALUES (
  4, 'PLC 實習講義', 'plc-handout',
  '課程講義與練習題，提供給修課學生。',
  'password', 1,
  'cloudflare', 'https://plc-handout.example.test',
  'worker', 'none',
  '2026-08-05T00:00:00Z', '2026-08-07T00:00:00Z'
);

-- ---------------------------------------------------------------------------
-- D：Private —— 只有管理者能開
-- ---------------------------------------------------------------------------
INSERT INTO projects (
  id, name, slug, description, visibility, category_id,
  platform, deployment_url, project_type, database_type,
  created_at, updated_at
) VALUES (
  5, '個人記帳工具', 'personal-budget',
  '私人用途，不對外公開。',
  'private', 3,
  'vercel', 'https://personal-budget.example.test',
  'fullstack', 'supabase',
  '2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z'
);

-- ---------------------------------------------------------------------------
-- E：Disabled —— 一律不提供內容
-- ---------------------------------------------------------------------------
INSERT INTO projects (
  id, name, slug, description, visibility, category_id,
  platform, deployment_url, project_type, database_type,
  created_at, updated_at
) VALUES (
  6, '舊版課程網站', 'legacy-course-site',
  '已被新版取代，暫時停用。',
  'disabled', 3,
  'cloudflare', 'https://legacy-course-site.example.test',
  'static', 'none',
  '2026-07-01T00:00:00Z', '2026-08-05T00:00:00Z'
);

-- ---------------------------------------------------------------------------
-- F：Worker + D1 —— 有伺服器端程式與資料庫的專案
-- ---------------------------------------------------------------------------
INSERT INTO projects (
  id, name, slug, description, visibility, category_id,
  platform, deployment_url, project_type, database_type,
  created_at, updated_at, last_deployed_at
) VALUES (
  7, '課堂留言板', 'class-message-board',
  '學生可以匿名提問，老師在課堂上一起回覆。資料存在 Cloudflare D1。',
  'public', 1,
  'cloudflare', 'https://class-message-board.example.test',
  'worker', 'd1',
  '2026-08-07T00:00:00Z', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
);

-- ---------------------------------------------------------------------------
-- G：Supabase Auth Demo —— 需要使用者登入的專案
-- ---------------------------------------------------------------------------
INSERT INTO projects (
  id, name, slug, description, visibility, category_id,
  platform, deployment_url, project_type, database_type,
  created_at, updated_at, last_deployed_at
) VALUES (
  8, '社團報名系統', 'club-signup',
  '學生用學校信箱登入後報名社團，名額即時更新。使用 Supabase 處理登入。',
  'public', 2,
  'supabase', 'https://club-signup.example.test',
  'fullstack', 'supabase',
  '2026-08-08T00:00:00Z', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
);

-- 標籤關聯：非公開專案也掛標籤，用來驗證篩選清單不會統計到它們。
INSERT INTO project_tags (project_id, tag_id) VALUES
  (1, 1), (1, 2),
  (2, 2),
  (3, 3),
  (5, 3),
  (7, 2), (7, 3),
  (8, 3);

-- C（Password）的政策資料。密碼雜湊只存在這張表。
-- 這是示範用的固定值，不是真實密碼；正式重複次數由實測結果決定。
INSERT INTO project_policies (project_id, policy_version, password_hash, updated_at) VALUES
  (4, 1, 'pbkdf2-sha256$10000$c2VlZHNhbHQ=$c2VlZGRlcml2ZWRrZXk=', '2026-08-07T00:00:00Z');

-- 部署紀錄範例：同一專案有成功與失敗，用來驗證排序與「失敗不覆蓋成功網址」。
INSERT INTO deployments (project_id, platform, deployment_url, version_ref, created_at, status) VALUES
  (1, 'cloudflare', 'https://resistor-color-code.example.test', 'a1b2c3d', '2026-08-10T00:00:00Z', 'success'),
  (7, 'cloudflare', 'https://class-message-board.example.test', 'e4f5g6h', '2026-08-11T00:00:00Z', 'success'),
  (7, 'cloudflare', 'https://class-message-board.example.test', 'broken1', '2026-08-11T01:00:00Z', 'failed');
