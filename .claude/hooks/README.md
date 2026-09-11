# hooks 狀態說明

## 目前狀態（2026-09-11）

| Hook | 狀態 | 說明 |
|---|---|---|
| **SessionStart** → `git-sync-pull.sh` | ✅ **啟用** | 開工自動 `git pull --ff-only`。只讀不寫，無外洩風險 |
| **Stop** → `git-sync-push.sh` | ⛔ **停用** | 腳本仍在，但已從 `settings.json` 移除，不會執行 |

---

## 為什麼停用 Stop

`git-sync-push.sh` 的檔頭明載：

> 安全前提：本腳本使用 `git add -A`，其安全性**完全依賴**專案的從嚴白名單 `.gitignore`。

**本 repo 的 `.gitignore` 是黑名單模式，這個前提不成立。**

2026-09-11 以 15 項誘餌檔實測（判準：`git add -An` 乾跑是否會加入），**漏接 6 項**：

```
id_rsa              ← 最嚴重：SSH 私鑰
資料庫匯出.sql
students.json
班級通訊錄.docx
備份.zip
config.yaml
```

自動 `git add -A` 沒有人眼把關，黑名單漏掉的東西**不會有任何提示就被 push 上去**。

---

## 怎麼重新啟用

**前提：`.gitignore` 必須先通過擴充誘餌測試（15 項全數擋住）。**

### 1. 跑誘餌測試

在 repo 根目錄建立這 15 個檔案，然後用 `git add -An` 乾跑確認**一個都不會被加入**：

```
名冊.xlsx    .env    node_modules/lib/index.js    screenshot.png    資料/成績.csv
secrets.toml    id_rsa    資料庫匯出.sql    students.json    班級通訊錄.docx
備份.zip    教室照片.jpg    data.db    chat.jsonl    config.yaml
```

**判準只有 `git add -An` 乾跑。**【嚴禁】用 `git check-ignore` 的結束碼判斷 —— 它對 `!` 放行規則也回傳 0。

測完記得刪除誘餌檔。

### 2. 通過後，把這段加回 `settings.json` 的 `hooks` 物件

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "d=$(git rev-parse --show-toplevel 2>/dev/null) && bash \"$d/.claude/hooks/git-sync-push.sh\"",
        "shell": "bash",
        "timeout": 90,
        "statusMessage": "自動 commit 並 push…"
      }
    ]
  }
]
```

> 註：`settings.json` 有結構驗證，**不能用 `_disabled` 之類的自訂欄位**存放停用的設定（會被判為 Unrecognized field）。要停用就整段移除，理由寫在本檔。

---

## 相關文件

完整的判準、安裝程序與踩雷紀錄在同步問題專案：

- `claude控制repo注意事項.md`
- `gitignore-從嚴範本.txt`
- `GitHub-Desktop-操作手冊.md` C-5（誘餌檔測試）
