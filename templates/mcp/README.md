# MCP 設定範本

把 hub 的 MCP server 掛到 AI 工具上。三種工具的設定檔格式不同，但**MCP server
本身完全一樣**——同一支 Node 程式三邊通用。

---

## 先看這裡：多數情況你什麼都不用做

**這個專案已經內建三種工具的專案層設定**，開啟資料夾就會自動掛上：

| 工具 | 已內建的檔案 | 條件 |
|---|---|---|
| Claude Code | `.mcp.json` | 無，開啟即生效 |
| Antigravity | `.agents/mcp_config.json` | 無，workspace 設定會被自動探索 |
| Codex | `.codex/config.toml` | 第一次開啟資料夾時選「信任這個目錄」 |

Codex 那個信任提示是它的安全機制：**只有受信任的專案才會載入專案層設定**。
那是第一次開啟資料夾時本來就會跳出來的一次性確認，選信任之後 Codex 會把
`trust_level = "trusted"` 記在你的使用者層設定裡，之後都不會再問。

> 如果選了「不信任」，`.codex/config.toml` 會被忽略而且**不會有任何錯誤訊息**。
> 遇到「Codex 查不到專案」時，這是第一個要檢查的地方。

掛好之後對 AI 說「列出我的專案」就會看到清單。

**以下內容只有在你要改設定、或要改成全域設定時才需要看。**

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
