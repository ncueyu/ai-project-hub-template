# CLAUDE.md

這個專案的 AI 操作規則寫在 `AGENTS.md`，**請先完整讀它再動手**。

@AGENTS.md

---

## 這個檔案為什麼只有一行匯入

使用者可能用 Claude Code、ChatGPT Desktop app（Codex 模式）或 Antigravity 之一操作
這個專案，而三個工具讀的指示檔各不相同（2026-08-27 查證官方文件）：

| 工具 | 會自動讀取 |
|---|---|
| Claude Code | `CLAUDE.md`（官方文件原文：「Claude Code reads `CLAUDE.md`, not `AGENTS.md`」） |
| ChatGPT Desktop app | `AGENTS.md`（只在 Codex 模式） |
| Antigravity | `.agents/agents.md` |

規則本體只放在 `AGENTS.md` 一處，這裡與 `.agents/agents.md` 都只做轉發——
三處各寫一份規則必然會漂移，改了一處忘了另外兩處。

`@AGENTS.md` 這個匯入語法是 Anthropic 官方文件給的相容做法。
官方另外也提供 symlink 的做法（`ln -s AGENTS.md CLAUDE.md`），但**本專案不能用**：
Windows 建立 symlink 需要系統管理員權限或開發者模式，而且 symlink 無法可靠地跟著
GitHub Template／ZIP 下載到使用者手上——這個專案的目標是讓不懂技術的老師下載後
能用，多一道「請以管理員身分執行」就少一批能照做的人。
