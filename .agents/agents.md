# Antigravity 的規則入口

**規則本體在專案根目錄的 `AGENTS.md`，請先完整讀那一份再動手。**

這裡刻意不複製內容——三處各寫一份規則必然會漂移，改了一處忘了另外兩處。

## 為什麼需要這個檔案

Google 官方文件與 Codelab 都指出 Antigravity 原生辨識的是 `.agents/` 這個特殊
資料夾（`.agents/agents.md` 或 `.agents/rules/*.md`）。至於「專案根目錄直接放一個
裸的 `AGENTS.md` 會不會被自動讀取」——只有第三方來源宣稱可以，**官方文件查無佐證**
（2026-08-27 查證）。所以這裡放一份明確的指路檔，不賭那個未確認的行為。

同一份規則的另外兩個入口：根目錄的 `AGENTS.md`（本體，供 ChatGPT Desktop 的
Codex 模式讀取）與 `CLAUDE.md`（供 Claude Code 讀取，內容只有一行 `@AGENTS.md`）。
