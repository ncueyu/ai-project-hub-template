#!/usr/bin/env bash
# git-sync-pull.sh —— SessionStart hook：開工前自動同步遠端
#
# 由 Claude Code 的 SessionStart hook 呼叫，屬非互動執行。
# 依 docs\17 §B 規則 2：被其他程式呼叫的腳本【不得】設 pause（會永久卡住 session）；
# 依 docs\17 §B 規則 4：所有輸出寫入 .claude/git-sync.log 供事後追查。
# 檔案規格：UTF-8 無 BOM、LF 換行（docs\17 §A 規則 4）。

set -u

emit_quiet() { echo '{"suppressOutput":true}'; }

root=$(git rev-parse --show-toplevel 2>/dev/null) || { emit_quiet; exit 0; }
cd "$root" || { emit_quiet; exit 0; }

# 沒有設定遠端就靜默跳過（艙 A 的專案沒有校外 remote，屬正常情況）
if [ -z "$(git remote 2>/dev/null)" ]; then
  emit_quiet
  exit 0
fi

mkdir -p .claude
log=".claude/git-sync.log"
stamp=$(date '+%Y-%m-%d %H:%M:%S')

out=$(git pull --ff-only 2>&1)
rc=$?

{
  echo "===== $stamp  SessionStart pull  (rc=$rc) ====="
  echo "$out"
} >> "$log"

if [ "$rc" -eq 0 ]; then
  emit_quiet
else
  # --ff-only 失敗最常見的原因是本機與遠端已分岔（兩台都有新 commit）。
  # 這種情況需要人判斷，【不得】自動 merge 或 rebase。
  echo '{"systemMessage":"git pull --ff-only 失敗，可能本機與遠端已分岔。請先看 .claude/git-sync.log 再決定如何處理，不要直接繼續工作。"}'
fi
