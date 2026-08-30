/**
 * `wrangler deploy --secrets-file`：把一份專案部署到 Cloudflare，同時把一組
 * Secret 隨部署一起設定上去。
 *
 * 從 `tools/ship.mjs` 抽出（工作計畫 2026-08-27-工作計畫-站名與hub-init.md
 * §4-1 (1)）。原本內嵌在 `shipProject()` 裡、寫死只處理一把
 * `SESSION_SIGNING_KEY`；這裡改成收 `Record<string, string>`，因為
 * `hub init` 部署展示中心自己時需要同時設定兩把——
 * `ADMIN_PASSWORD_HASH` 與 `SESSION_SIGNING_KEY`。
 *
 * ## 為什麼用 `--secrets-file`，不用 `wrangler secret put`
 *
 * `wrangler secret put` 要從 stdin 互動讀值，本專案的 `runCommand` 沒有
 * （也不該有）餵 stdin 的能力——那個介面設計給不需要輸入的指令用。改用
 * `wrangler deploy --secrets-file <檔案>`（官方文件的說法：「Applies
 * additively with secrets from previous deployments」），一次指令同時
 * 完成部署與設定金鑰，不必額外處理互動輸入。
 *
 * ## 兩個必須保留的既有行為（都是踩過坑才有的）
 *
 * 1. 暫存檔寫在**系統暫存目錄**，不寫進目標專案資料夾——避免它有任何
 *    機會被之後的 git 操作意外掃進版控。部署指令結束後立刻刪除，不管
 *    成功或失敗都要刪，所以用 try/finally。
 * 2. 部署指令一律 `runCommand(process.execPath, [resolveWranglerEntry(),
 *    ...args], dir)`——`wrangler.js` 的路徑**不能當 `spawn()` 的 command
 *    本身**，Windows 上會得到 `EFTYPE`（2026-08-26 真部署測試時實際踩到）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWranglerEntry } from "./d1.mjs";
import { run } from "./github.mjs";

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} CommandResult
 */

/**
 * @param {string} dir 目標專案資料夾（`wrangler deploy` 的 cwd）
 * @param {Record<string, string>} secrets 空物件代表「這次部署不隨帶任何 Secret」
 * @param {{ runCommand?: typeof run }} [options]
 * @returns {Promise<CommandResult>}
 */
export async function deployWithSecrets(dir, secrets, options = {}) {
  const runCommand = options.runCommand ?? run;
  const entries = Object.entries(secrets ?? {});

  let secretsDir = null;

  try {
    const deployArgs = ["deploy"];

    if (entries.length > 0) {
      secretsDir = mkdtempSync(join(tmpdir(), "hub-deploy-secrets-"));
      const secretsPath = join(secretsDir, "secrets.env");

      // .env 格式：KEY=VALUE，一行一組。值本身（雜湊、隨機金鑰）不含換行，
      // 不需要額外跳脫——`hash-admin-password.mjs` 產生的雜湊與
      // `generateSigningKey()` 產生的十六進位字串都是單行安全字元。
      const contents = entries.map(([key, value]) => `${key}=${value}\n`).join("");

      writeFileSync(secretsPath, contents, "utf8");
      deployArgs.push("--secrets-file", secretsPath);
    }

    return await runCommand(process.execPath, [resolveWranglerEntry(), ...deployArgs], dir);
  } finally {
    if (secretsDir) {
      rmSync(secretsDir, { recursive: true, force: true });
    }
  }
}
