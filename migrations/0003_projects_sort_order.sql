-- Migration 0003：projects 新增 sort_order（主卡片排序）
--
-- 依據：2026-08-28-工作計畫-主畫面改造.md Part D（主卡片）與第 3-4 節設計。
--
-- 為什麼需要這個欄位：
--   展示中心目前只能靠 `updated_at DESC, id DESC` 排序，管理者沒有辦法
--   指定「這個專案永遠排第一個」——那個順位會隨每次編輯、每次新部署紀錄
--   而不斷變動。後台需要一個「設為主卡片」的動作，讓某個專案穩定地
--   顯示在展示中心第一位，並在該位置加上七彩光暈標示。這需要一個
--   不受其他欄位變動影響的獨立排序欄位。
--
-- 預設值為什麼是 0，而不是像 links／categories 一樣直接當成一般排序欄位：
--   0 代表「尚未指定任何主卡片」的中性狀態。「設為主卡片」動作會把目標
--   專案設為 1、其餘依目前顯示順序重新編號成 2、3、4……（見
--   `src/repositories/projects.js` 的 `setPrimaryProject`）。如此一來，
--   任何專案在「還沒被設為主卡片」之前一律是 0，多筆 0 之間的順序完全
--   交給既有的 `updated_at DESC, id DESC` 決定——這正是既有專案不設定也
--   不會亂序的原因：新查詢 `ORDER BY p.sort_order ASC, p.updated_at DESC,
--   p.id DESC` 在 sort_order 全部相同（0）時，效果等同於改動前的排序。
--
-- 索引與新的 ORDER BY 子句一一對應（過濾欄位＋排序欄位複合索引，
-- 與 0001 的 idx_projects_visibility_updated 同一種慣例），讓排序不必
-- 做全表掃描。

ALTER TABLE projects
  ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_projects_sort_order
  ON projects (sort_order ASC, updated_at DESC, id DESC);
