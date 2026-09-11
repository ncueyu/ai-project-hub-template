#!/usr/bin/env bash
# git-sync-push.sh —— Stop hook：每次回應結束時，有變更就自動 commit + push
#
# 由 Claude Code 的 Stop hook 呼叫，屬非互動執行。
# 依 docs\17 §B 規則 2：被其他程式呼叫的腳本【不得】設 pause；
# 依 docs\17 §B 規則 4：所有輸出寫入 .claude/git-sync.log 供事後追查。
# 檔案規格：UTF-8 無 BOM、LF 換行（docs\17 §A 規則 4）。
#
# 安全前提：本腳本使用 git add -A，其安全性【完全依賴】專案的從嚴白名單
# .gitignore（gitignore-從嚴範本 V1.0）。若該 .gitignore 被改成黑名單模式，
# 或第 5 區的封鎖規則被刪除，本腳本會自動把敏感檔案 commit 並 push 出去。
# 更換 .gitignore 前必須重跑誘餌檔測試（見 GitHub-Desktop-操作手冊 C-5）。

set -u

emit_quiet() { echo '{"suppressOutput":true}'; }

root=$(git rev-parse --show-toplevel 2>/dev/null) || { emit_quiet; exit 0; }
cd "$root" || { emit_quiet; exit 0; }

changes=$(git status --porcelain)
unpushed=$(git log --branches --not --remotes --oneline 2>/dev/null)

# 沒有未提交變更、也沒有未推送的 commit → 什麼都不做（大多數回應會走這條）
if [ -z "$changes" ] && [ -z "$unpushed" ]; then
  emit_quiet
  exit 0
fi

mkdir -p .claude
log=".claude/git-sync.log"
stamp=$(date '+%Y-%m-%d %H:%M:%S')

{
  echo "===== $stamp  Stop auto-sync ====="
  if [ -n "$changes" ]; then
    echo "--- 加入索引後將提交的檔案 ---"
    git add -A
    git status --short
    echo "--- commit ---"
    git commit -m "auto: $stamp" 2>&1
  else
    echo "--- 無未提交變更，僅推送既有 commit ---"
  fi
  if [ -n "$(git remote 2>/dev/null)" ]; then
    echo "--- push ---"
    git push origin HEAD 2>&1
  else
    echo "--- 無遠端，僅本機 commit（艙 A 的正常狀態）---"
  fi
} >> "$log" 2>&1

# 驗證：工作區乾淨，且沒有未推送的 commit（無遠端時只驗前者）
still_dirty=$(git status --porcelain)
still_unpushed=$(git log --branches --not --remotes --oneline 2>/dev/null)

if [ -z "$(git remote 2>/dev/null)" ]; then
  if [ -z "$still_dirty" ]; then
    echo '{"systemMessage":"已自動 commit 至本機（此專案無遠端）。"}'
  else
    echo '{"systemMessage":"自動 commit 未完成，請看 .claude/git-sync.log。"}'
  fi
elif [ -z "$still_dirty" ] && [ -z "$still_unpushed" ]; then
  echo '{"systemMessage":"已自動 commit 並 push。"}'
else
  echo '{"systemMessage":"自動同步未完成 —— 工作區或遠端仍不一致，請看 .claude/git-sync.log。"}'
fi
