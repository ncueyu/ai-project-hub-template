# MCP 設定範本

把 hub 的 MCP server 掛到 AI 工具上。三種工具的設定檔格式不同，但**MCP server 本身完全一樣**——同一支 Node 程式三邊通用。

> **先做這件事**：把範本裡的 `<專案絕對路徑>` 換成這個專案在你電腦上的實際位置。
> 想知道路徑是什麼，在專案資料夾執行：
>
> ```bash
> node -e "console.log(process.cwd())"
> ```
>
> Windows 的路徑請用**正斜線**（`E:/專案/ai-project-hub`）或**雙反斜線**（`E:\\專案\\ai-project-hub`）。單一反斜線在 JSON 裡是跳脫字元，會讓設定檔解析失敗。

---

## Claude Code

| 檔案 | 範本 |
|---|---|
| 專案層：專案根目錄的 `.mcp.json` | `claude-code.json` |
| 使用者層：`~/.claude.json` 的 `mcpServers` 區塊 | 同上，只取 `mcpServers` 內容 |

專案層的設定只有在該資料夾開啟時生效；使用者層則到哪都能用。

## Antigravity

| 範圍 | 檔案位置 |
|---|---|
| 全域 | `~/.gemini/config/mcp_config.json` |
| 工作區 | 專案內 `.agents/mcp_config.json` |

範本：`antigravity.json`

在編輯器中也可以從 agent 面板上方的「⋯」開啟 MCP store →「Manage MCP Servers」→「View raw config」直接編輯同一份檔案。IDE、CLI 與 SDK 共用這份設定，設定一次三邊都吃得到。

## Codex

| 範圍 | 檔案位置 |
|---|---|
| 全域 | `~/.codex/config.toml` |
| 專案 | 專案內 `.codex/config.toml` |

範本：`codex.toml`

也可以用指令加，避免手寫 TOML 出錯：

```bash
codex mcp add ai-project-hub -- node <專案絕對路徑>/bin/hub-mcp.mjs
```

---

## 掛好之後怎麼確認

對 AI 說：

> 列出我的專案

應該會看到專案清單。沒反應的話，依序檢查：

1. **路徑對不對**——直接執行 `node <專案絕對路徑>/bin/hub.mjs list`，先確認程式本身能跑
2. **反斜線**——JSON 裡的單一反斜線會讓整份設定檔解析失敗
3. **重新啟動 AI 工具**——多數工具只在啟動時讀取 MCP 設定
4. **相依套件裝了沒**——在專案根目錄執行 `node scripts/check-environment.mjs`

## 目前提供的工具（皆為唯讀）

| 工具 | 作用 |
|---|---|
| `list_projects` | 列出專案，可依可見性篩選 |
| `get_project` | 以代稱或編號取得單一專案 |
| `get_deployment_status` | 取得線上網址與最近的部署紀錄 |

會改變狀態的工具（部署、改可見性、回復）屬於階段 G，尚未提供。
