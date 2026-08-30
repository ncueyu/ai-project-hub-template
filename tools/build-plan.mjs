/**
 * 建置計畫（2026-08-14 工作計畫 TASK B-2）。
 *
 * 由偵測結果產生一份「要跑什麼指令、產物在哪、往哪個平台送」的資料。
 * 一樣**只產生計畫，不執行**——計畫是可以印出來給人看、給測試比對的東西；
 * 混進執行就兩者都難驗證。
 */

import { detectProject } from "./detect.mjs";

/** 各型態的預設產物目錄。 */
const DEFAULT_OUTPUT = Object.freeze({
  worker: null,
  nextjs: ".next",
  vue: "dist",
  react: "dist",
  vite: "dist",
  "node-api": null,
  static: ".",
  unknown: null,
});

/** 各型態的預設目標平台。 */
const DEFAULT_PLATFORM = Object.freeze({
  worker: "cloudflare",
  nextjs: "vercel",
  vue: "cloudflare",
  react: "cloudflare",
  vite: "cloudflare",
  "node-api": "vercel",
  static: "cloudflare",
  unknown: null,
});

/**
 * 建置指令。用專案自己的 `build` script，而不是猜一個框架預設指令——
 * 專案可能在 build 前後接了其他步驟，繞過它等於部署了不完整的產物。
 *
 * @param {"pnpm" | "yarn" | "npm" | null} packageManager
 * @returns {string}
 */
function buildCommand(packageManager) {
  if (packageManager === "pnpm") {
    return "corepack pnpm run build";
  }

  if (packageManager === "yarn") {
    return "yarn run build";
  }

  return "npm run build";
}

/**
 * @typedef {{
 *   kind: string,
 *   command: string | null,
 *   output: string | null,
 *   platform: string | null,
 *   packageManager: string | null,
 *   notes: string[],
 *   blockers: string[],
 * }} BuildPlan
 */

/**
 * 產生建置計畫。
 *
 * @param {string} dir 專案目錄
 * @param {{ detection?: ReturnType<typeof detectProject> }} [options]
 * @returns {BuildPlan}
 */
export function planBuild(dir, options = {}) {
  const detection = options.detection ?? detectProject(dir);
  const { kind, packageManager, hasBuildScript } = detection;

  /** wrangler 設定檔宣告的 assets 目錄（只有 wrangler 專案才有值）。 */
  const assetsDirectory = /** @type {any} */ (detection).wranglerAssets ?? null;
  /** wrangler 設定檔是否宣告 main（有 main = 真正的 Worker）。 */
  const wranglerHasMain = /** @type {any} */ (detection).wranglerHasMain === true;

  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const blockers = [];

  let command = null;
  /** @type {string | null} */
  let output = DEFAULT_OUTPUT[kind] ?? null;

  if (kind === "static") {
    notes.push("靜態網站不需要建置，直接上傳檔案。");

    // 產物位置：優先採用 wrangler 設定檔宣告的 assets 目錄（2026-08-17 新增）。
    //
    // 原本一律回報 `.`（專案根目錄），但那個值**不可以照字面執行**：
    //   1. Wrangler 會把自己產生的 `.wrangler/tmp/` 暫存檔一起算進資產。
    //      實測同一個專案、真正的網站檔案只有 1 個，卻回報 Read 10 files（有暫存檔時）
    //      與 Read 7 files（清掉後）——數字會漂移，而且暫存檔會被上傳到公開網站。
    //   2. `.assetsignore` 在該情境沒有生效。
    //   3. 根目錄還放著 project-hub.json、wrangler.jsonc、縮圖——都不是網站內容，
    //      卻會被算進「產物大小」與「靜態檔案數量」，讓這兩個檢查失去意義。
    //
    // 因此網站檔案一律放專屬子目錄，這裡就跟著讀出那個目錄。
    // 讀不到 assets 宣告時才退回 `.`，並明確提醒。
    if (assetsDirectory !== null) {
      output = assetsDirectory;
      notes.push(`產物位置取自 wrangler 設定檔的 assets 目錄（${assetsDirectory}）。`);
    } else {
      notes.push(
        "找不到 wrangler 設定檔的 assets 目錄，產物位置暫以專案根目錄計算。"
        + "建議把網站檔案放進專屬子目錄（例如 public/）並在 wrangler 設定檔宣告，"
        + "否則設定檔與 Wrangler 的暫存檔都會被當成網站內容上傳。",
      );
    }
  } else if (kind === "worker") {
    notes.push("Worker 的打包由 Wrangler 處理，不需要另外的建置指令。");
  } else if (kind === "unknown") {
    blockers.push("無法判斷專案型態。請在 project-hub.json 指定，或確認專案結構。");
  } else if (hasBuildScript) {
    command = buildCommand(packageManager);
  } else {
    blockers.push(`偵測為 ${kind}，但 package.json 沒有 build 指令，無法建置。`);
  }

  if (kind === "nextjs") {
    notes.push("Next.js 部署到 Cloudflare 需要額外的轉接層；第一版預設走 Vercel。");
  }

  if (kind === "node-api") {
    notes.push("Node API 需要常駐執行環境，Cloudflare Workers 不直接支援；第一版預設走 Vercel。");
  }

  // 沒有 main 的 wrangler 專案 → assets 目錄**就是**實際被部署的產物，
  // 不論專案型態是 static、react 還是 vite（2026-08-22 統一）。
  //
  // 為什麼不能只靠型態的預設值：react 的預設產物是 `dist`，剛好對得上多數 Vite 專案，
  // 但若使用者把 assets 指向 `build/` 或 `out/`，預設值就錯了——
  // 而 wrangler 設定檔是「什麼會被上傳」的權威來源，該以它為準。
  //
  // 有 main 的真 Worker 不套用：那時 assets 只是 Worker 附帶的靜態檔目錄，
  // 不是建置產物，覆寫會讓產物大小與 Source Map 檢查看錯目錄。
  if (wranglerHasMain === false && assetsDirectory !== null && output !== assetsDirectory) {
    notes.push(`產物位置改用 wrangler 設定檔宣告的 assets 目錄（${assetsDirectory}），型態預設值為 ${output ?? "（無）"}。`);
    output = assetsDirectory;
  }

  return {
    kind,
    command,
    output,
    platform: DEFAULT_PLATFORM[kind] ?? null,
    packageManager,
    notes,
    blockers,
  };
}

/**
 * 把計畫轉成人看得懂的文字。
 *
 * @param {BuildPlan} plan
 * @returns {string}
 */
export function renderPlan(plan) {
  const lines = [
    `專案型態：${plan.kind}`,
    `建置指令：${plan.command ?? "（不需要）"}`,
    `產物位置：${plan.output ?? "（不適用）"}`,
    `目標平台：${plan.platform ?? "（未定）"}`,
    `套件管理器：${plan.packageManager ?? "（無）"}`,
  ];

  if (plan.notes.length > 0) {
    lines.push("", "說明：");

    for (const note of plan.notes) {
      lines.push(`  · ${note}`);
    }
  }

  if (plan.blockers.length > 0) {
    lines.push("", "無法繼續的原因：");

    for (const blocker of plan.blockers) {
      lines.push(`  · ${blocker}`);
    }
  }

  return lines.join("\n");
}
