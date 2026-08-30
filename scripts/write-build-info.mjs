#!/usr/bin/env node
// @ts-check

/**
 * 產生部署資訊檔。
 *
 * 為什麼需要這一支：頁尾要顯示「這個網站是什麼時候更新的」，而這個時間
 * 必須是**部署當下的時間**，不能用瀏覽器的時鐘。瀏覽器時間是訪客電腦的
 * 時間，可能不準、可能被改，而且每個訪客看到的都不一樣。
 *
 * 因此在建置／部署時把時間寫進一個檔案，頁面再讀取它。這個時間之後
 * 不會改變，直到下次重新部署。
 *
 * 執行：pnpm run build:info（部署前會自動執行）
 *
 * 環境判定的優先序（2026-08-16 修正）：
 *   1. CLI 參數 `--env=<值>`
 *   2. 環境變數 BUILD_ENVIRONMENT
 *   3. 預設 "local"
 *
 * 為什麼要有 CLI 參數：原本只讀 BUILD_ENVIRONMENT，但 package.json 的 deploy
 * 指令並未設定它，導致正式部署出去的頁尾仍顯示「本機開發版本」徽章
 * （public/site-footer.js:82 判斷 environment !== "production" 就掛徽章）。
 * 而 Windows 的 cmd/PowerShell 不支援 `VAR=x cmd` 這種前綴語法，
 * 在 npm script 裡設環境變數需要額外套件；改用 CLI 參數最單純且跨平台。
 */

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "public", "build-info.json");

/**
 * 從 `--env=<值>` 取出環境名稱。
 *
 * @returns {string | undefined}
 */
function environmentFromArgv() {
  const flag = process.argv.slice(2).find((arg) => arg.startsWith("--env="));

  if (!flag) {
    return undefined;
  }

  const value = flag.slice("--env=".length).trim();

  return value === "" ? undefined : value;
}

const info = {
  // 以 UTC 記錄，顯示時再轉成台北時間。
  deployedAt: new Date().toISOString(),
  environment: environmentFromArgv() ?? process.env.BUILD_ENVIRONMENT ?? "local",
};

await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(info, null, 2)}\n`, "utf8");

console.log(`Build info written: ${info.deployedAt} (${info.environment})`);
