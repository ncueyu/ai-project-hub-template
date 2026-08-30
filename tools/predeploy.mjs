/**
 * 部署前檢查（2026-08-14 工作計畫 TASK B-3）。
 *
 * 核心規則：**任一重大項目失敗即停止部署**。這裡不做「警告一下還是讓它過」
 * 的折衷——會被略過的檢查等於沒有檢查。
 *
 * 檢查分兩級：
 *   - critical（重大）：失敗就不准部署。
 *   - advisory（提醒）：回報但不擋。
 *
 * 尺寸門檻是**本工具的保守警戒值，不是官方額度**。Cloudflare 的實際上限
 * 會隨方案與時間變動，寫死在程式裡遲早會過期；需要精確數字時請查當時的
 * 官方文件。這裡的用途只是「在明顯過大時先提醒」。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { planBuild } from "./build-plan.mjs";
import { ALLOW_FILENAME, scanDeployables, scanLimitations } from "./deploy-scan.mjs";
import { readPackageJson } from "./detect.mjs";
import { scanDirectory } from "./secrets.mjs";
import { describeThumbnail } from "./thumbnail.mjs";

/** Worker 指令碼的保守警戒值（未壓縮）。 */
export const WORKER_SCRIPT_WARN_BYTES = 1024 * 1024;

/** 建置產物總大小的保守警戒值。 */
export const BUNDLE_WARN_BYTES = 25 * 1024 * 1024;

/** 靜態檔案數量的保守警戒值。 */
export const ASSET_COUNT_WARN = 10_000;

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   level: "critical" | "confirm" | "advisory",
 *   status: "pass" | "fail" | "skip",
 *   detail: string,
 * }} CheckResult
 */

/**
 * 三個級別的語意（2026-08-17 新增 confirm 級）：
 *
 *   critical（重大）—— 失敗就不准部署，不詢問。
 *   confirm（需確認）—— 列出來並說明原因，等使用者放行後才可部署。
 *   advisory（提醒）—— 回報但不擋。
 *
 * 為什麼要有中間這一級：原本只有「擋」與「不擋」兩種。
 * 名單、試算表、開發文件這類東西**無法自動判定該不該上傳**——
 * 同一份 CSV 可能是真實名冊（絕不可上傳），也可能是刻意提供下載的範本。
 * 硬歸為 critical 會讓合法情況無法部署；歸為 advisory 則會在一長串提醒中被滑過去。
 * 兩者都會導向同一個壞結果：使用者學會忽略這個檢查。
 */

/**
 * 執行一個指令並回傳結果。
 *
 * 使用 shell 是刻意的——指令字串來自 `build-plan.mjs` 的固定常數
 * （例如 `corepack pnpm run build`），不是使用者或 AI 提供的輸入。
 * 若日後要接受外部提供的指令，這裡必須改成陣列形式的參數。
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {Promise<{ code: number, output: string }>}
 */
function run(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true });

    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 0, output });
    });
  });
}

/**
 * 取得「這個專案推到 GitHub 時會包含哪些檔案」。
 *
 * 為什麼是 `ls-files --cached --others --exclude-standard`，而不是
 * `add -A --dry-run`：後者只列出**尚未暫存的變更**。專案第一次 commit 前
 * 兩者結果相同，但一旦 commit 過，`add --dry-run` 就只剩差集——
 * 實測本專案為 27 對 306，用錯的那個會讓已 commit 的檔案全部被當成「不在版控裡」。
 *
 * `--cached` 是已追蹤的、`--others` 是未追蹤的、`--exclude-standard` 讓它
 * 遵守 .gitignore。三者合起來正好是「git 會送出去的完整範圍」。
 *
 * `core.quotepath=false` 不能省：預設值會把中文檔名輸出成 `\350\246\201...`
 * 這種八進位轉義，跟掃描器手上的實際路徑對不起來，比對會全部失敗。
 *
 * @param {string} dir
 * @returns {Promise<Set<string> | null>} 不是 git 專案或 git 不可用時回傳 null
 */
async function collectGitFiles(dir) {
  const probe = await run("git rev-parse --is-inside-work-tree", dir).catch(() => null);

  if (probe === null || probe.code !== 0 || probe.output.trim() !== "true") {
    return null;
  }

  const listed = await run(
    "git -c core.quotepath=false ls-files --cached --others --exclude-standard",
    dir,
  ).catch(() => null);

  if (listed === null || listed.code !== 0) {
    return null;
  }

  const files = listed.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  return new Set(files);
}

/**
 * 走訪目錄，統計檔案數與總大小。
 *
 * @param {string} dir
 * @returns {{ count: number, bytes: number, sourceMaps: string[] }}
 */
export function measureOutput(dir) {
  let count = 0;
  let bytes = 0;
  /** @type {string[]} */
  const sourceMaps = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();

    let entries;

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      count += 1;

      try {
        bytes += statSync(full).size;
      } catch {
        // 讀不到大小就跳過統計，不影響其他檔案。
      }

      if (extname(entry.name).toLowerCase() === ".map") {
        sourceMaps.push(full);
      }
    }
  }

  return { count, bytes, sourceMaps };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * 執行部署前檢查。
 *
 * @param {string} dir
 * @param {{
 *   plan?: ReturnType<typeof planBuild>,
 *   runBuild?: boolean,
 *   runTests?: boolean,
 *   runTypecheck?: boolean,
 * }} [options]
 * @returns {Promise<{ checks: CheckResult[], blocked: boolean, needsConfirmation: boolean }>}
 */
export async function runPreDeployChecks(dir, options = {}) {
  const plan = options.plan ?? planBuild(dir);
  const pkg = readPackageJson(dir);
  /** @type {CheckResult[]} */
  const checks = [];

  /**
   * @param {CheckResult} result
   */
  function add(result) {
    checks.push(result);
  }

  // 1. 建置計畫本身是否可行。計畫都排不出來就沒有後面的事。
  if (plan.blockers.length > 0) {
    add({
      id: "plan",
      title: "建置計畫",
      level: "critical",
      status: "fail",
      detail: plan.blockers.join("；"),
    });
  } else {
    add({ id: "plan", title: "建置計畫", level: "critical", status: "pass", detail: `型態 ${plan.kind}` });
  }

  // 1-B. 縮圖。先做這一步，因為 1-C 的掃描要把縮圖排除在「夾帶物」之外。
  const thumbnail = describeThumbnail(dir);

  add({
    id: "thumbnail",
    title: "專案縮圖",
    level: "advisory",
    status: thumbnail.found ? "pass" : "fail",
    detail: thumbnail.detail,
  });

  // 1-C. 不該上傳的檔案。看檔名與副檔名，與 Secret 掃描（看內容）互補。
  //
  //      為什麼兩種都要：`.env` 的內容是合法的 KEY=VALUE、名單 CSV 的內容是合法表格、
  //      照片是二進位——內容掃描一個都抓不到，只有檔名能當線索。
  // 傳入產物目錄，讓掃描結果能標示「這個檔案這次會不會真的被上傳」。
  // 不傳的話所有發現都會被當成「會上傳」，對產物在子目錄的專案是過度警告。
  // 同時取得版控範圍。產物目錄決定「會不會公開在網站上」，
  // 版控範圍決定「會不會被推到 GitHub」——兩批檔案不同，必須分別判斷。
  const gitFiles = await collectGitFiles(dir);

  const deployScan = scanDeployables(dir, {
    thumbnail: thumbnail.source?.path ?? null,
    outputDir: plan.output,
    gitFiles,
  });

  /**
   * 說明一個檔案會被送到哪些地方。
   *
   * 一個專案有兩個出口，範圍不一樣，所以要分別回答：
   *   Cloudflare → 只送產物目錄裡的東西，送出去就是「公開在網路上」
   *   GitHub     → 送所有沒被 .gitignore 擋掉的東西，送出去就是「永久留在版控歷史」
   *
   * 2026-08-23 之前這裡只看產物目錄，於是把「不在產物目錄」寫成
   * 「這次不會上傳」——那句話在 GitHub 也是出口之後就是錯的，
   * 而且會緊接在「它會被推到 GitHub」的說明前面，自相矛盾。
   *
   * @param {{ inOutput?: boolean, inGit?: boolean | null }} item
   * @returns {string}
   */
  function describeDestinations(item) {
    const toWeb = item.inOutput !== false;
    const toGit = item.inGit;

    if (toGit === null || toGit === undefined) {
      return toWeb
        ? "（★ 會公開在網站上；未取得版控資訊）"
        : "（不在產物目錄，不會公開在網站上；未取得版控資訊）";
    }

    if (toWeb && toGit) return "（★★ 會公開在網站上，也會進版控）";
    if (toWeb && !toGit) return "（★ 會公開在網站上；不進版控）";
    if (!toWeb && toGit) return "（★ 不會出現在網站上，但會進版控 → 推到 GitHub）";

    return "（兩個出口都不會送出，只存在本機）";
  }

  /**
   * @param {{ path: string, reason: string, hint?: string }[]} items
   * @returns {string}
   */
  function describeFiles(items) {
    return items
      .slice(0, 12)
      .map((item) => {
        const hint = item.hint ? `\n        ${item.hint}` : "";

        return `\n      · ${item.path} ${describeDestinations(item)}\n        ${item.reason}${hint}`;
      })
      .join("")
      + (items.length > 12 ? `\n      （共 ${items.length} 項，僅顯示前 12 項）` : "");
  }

  add({
    id: "forbidden-files",
    title: "禁止上傳的檔案",
    level: "critical",
    status: deployScan.blocking.length === 0 ? "pass" : "fail",
    detail: deployScan.blocking.length === 0
      ? `掃描 ${deployScan.scanned} 個檔案，未發現憑證或金鑰類檔案`
      : `發現 ${deployScan.blocking.length} 項：${describeFiles(deployScan.blocking)}`
        + "\n      這一級不接受放行。正確做法是把檔案移出專案資料夾，而不是宣告它沒問題。",
  });

  add({
    id: "confirm-files",
    title: "需你確認的檔案",
    level: "confirm",
    status: deployScan.confirm.length === 0 ? "pass" : "fail",
    detail: deployScan.confirm.length === 0
      ? `掃描 ${deployScan.scanned} 個檔案，未發現需確認項目`
        + (deployScan.allowedCount > 0 ? `（另有 ${deployScan.allowedCount} 項已在 ${ALLOW_FILENAME} 放行）` : "")
      : `發現 ${deployScan.confirm.length} 項：${describeFiles(deployScan.confirm)}`
        + `\n\n      確認可以上傳的項目，把路徑逐行寫進 ${dir}\\${ALLOW_FILENAME}，之後就不會再問。`
        + "\n      確認不該上傳的，直接把檔案移出專案資料夾。",
  });

  for (const note of scanLimitations(dir)) {
    add({
      id: `limitation-${checks.length}`,
      title: "掃描做不到的部分",
      level: "advisory",
      status: "skip",
      detail: note,
    });
  }

  // 2. Secret 掃描。整份檢查裡最重要的一項。
  //
  //    原始碼與測試檔分開判定：測試**必須**含有假憑證才驗得了擋不擋得住，
  //    把它們算成重大失敗會讓這個檢查永遠是紅的，接著就會被人習慣性略過。
  const scan = scanDirectory(dir);
  const sourceFindings = scan.findings.filter((finding) => finding.context === "source");
  const testFindings = scan.findings.filter((finding) => finding.context === "test");
  const vendorFindings = scan.findings.filter((finding) => finding.context === "vendor");

  /**
   * @param {any[]} findings
   * @returns {string}
   */
  function describeFindings(findings) {
    const shown = findings
      .slice(0, 10)
      .map((finding) => `${finding.path}:${finding.line} ${finding.label}（${finding.excerpt}）`)
      .join("\n      ");

    return `發現 ${findings.length} 處：\n      ${shown}`
      + (findings.length > 10 ? "\n      （僅顯示前 10 處）" : "");
  }

  add({
    id: "secrets",
    title: "Secret 掃描",
    level: "critical",
    status: sourceFindings.length === 0 ? "pass" : "fail",
    detail: sourceFindings.length === 0
      ? `掃描 ${scan.scanned} 個檔案，原始碼中未發現金鑰`
        + (scan.truncated ? "（已達檔案數上限，未掃完整個目錄）" : "")
      : describeFindings(sourceFindings),
  });

  // 第三方套件的打包產物：列出但不擋。理由見 secrets.mjs 的 isVendorBundlePath()。
  if (vendorFindings.length > 0) {
    add({
      id: "secrets-vendor",
      title: "Secret 掃描（第三方套件產物）",
      level: "advisory",
      status: "fail",
      detail: describeFindings(vendorFindings)
        + "\n      這些在第三方套件的打包產物裡，你改不了（那是別人的程式碼）。"
        + "多數是屬性名對應到同名字串，不是真的憑證。不擋部署，但值得抽看一次確認。",
    });
  }

  if (testFindings.length > 0) {
    add({
      id: "secrets-test",
      title: "Secret 掃描（測試檔）",
      level: "advisory",
      status: "fail",
      detail: `${describeFindings(testFindings)}\n      測試檔通常放的是假憑證，不擋部署；但請確認裡面沒有真的金鑰。`,
    });
  }

  // 3. 型別檢查。
  if (options.runTypecheck !== false && typeof pkg?.scripts?.typecheck === "string") {
    const { code, output } = await run("npm run typecheck", dir);

    add({
      id: "typecheck",
      title: "型別檢查",
      level: "critical",
      status: code === 0 ? "pass" : "fail",
      detail: code === 0 ? "通過" : output.trim().split("\n").slice(-5).join("\n      "),
    });
  } else {
    add({
      id: "typecheck",
      title: "型別檢查",
      level: "critical",
      status: "skip",
      detail: options.runTypecheck === false ? "依指定略過" : "專案沒有 typecheck 指令",
    });
  }

  // 4. 測試。
  if (options.runTests !== false && typeof pkg?.scripts?.test === "string") {
    const { code, output } = await run("npm test", dir);

    add({
      id: "tests",
      title: "測試",
      level: "critical",
      status: code === 0 ? "pass" : "fail",
      detail: code === 0 ? "通過" : output.trim().split("\n").slice(-5).join("\n      "),
    });
  } else {
    add({
      id: "tests",
      title: "測試",
      level: "critical",
      status: "skip",
      detail: options.runTests === false ? "依指定略過" : "專案沒有 test 指令",
    });
  }

  // 5. 建置。
  if (options.runBuild !== false && plan.command) {
    const { code, output } = await run(plan.command, dir);

    add({
      id: "build",
      title: "建置",
      level: "critical",
      status: code === 0 ? "pass" : "fail",
      detail: code === 0 ? plan.command : output.trim().split("\n").slice(-5).join("\n      "),
    });
  } else {
    add({
      id: "build",
      title: "建置",
      level: "critical",
      status: "skip",
      detail: plan.command ? "依指定略過" : "此型態不需要建置",
    });
  }

  // 6. 產物檢查：Source Map、大小、檔案數。
  const outputDir = plan.output ? join(dir, plan.output) : null;

  if (outputDir && existsSync(outputDir)) {
    const measured = measureOutput(outputDir);

    add({
      id: "source-map",
      title: "Source Map",
      level: "critical",
      status: measured.sourceMaps.length === 0 ? "pass" : "fail",
      detail: measured.sourceMaps.length === 0
        ? "產物中沒有 .map 檔案"
        : `產物中有 ${measured.sourceMaps.length} 個 .map，會把原始碼一併公開`,
    });

    add({
      id: "bundle-size",
      title: "產物大小",
      level: "advisory",
      status: measured.bytes <= BUNDLE_WARN_BYTES ? "pass" : "fail",
      detail: `${formatBytes(measured.bytes)}（警戒值 ${formatBytes(BUNDLE_WARN_BYTES)}）`,
    });

    add({
      id: "asset-count",
      title: "靜態檔案數量",
      level: "advisory",
      status: measured.count <= ASSET_COUNT_WARN ? "pass" : "fail",
      detail: `${measured.count} 個（警戒值 ${ASSET_COUNT_WARN} 個）`,
    });
  } else {
    for (const [id, title] of [["source-map", "Source Map"], ["bundle-size", "產物大小"], ["asset-count", "靜態檔案數量"]]) {
      add({
        id,
        title,
        level: id === "source-map" ? "critical" : "advisory",
        status: "skip",
        detail: outputDir ? "產物目錄不存在（尚未建置）" : "此型態沒有產物目錄",
      });
    }
  }

  // 7. Worker 指令碼大小。
  if (plan.kind === "worker") {
    const main = typeof pkg?.main === "string" ? pkg.main : "src/index.js";
    const entry = join(dir, main);

    if (existsSync(entry)) {
      const size = statSync(entry).size;

      add({
        id: "worker-size",
        title: "Worker 指令碼大小",
        level: "advisory",
        status: size <= WORKER_SCRIPT_WARN_BYTES ? "pass" : "fail",
        detail: `${formatBytes(size)}（警戒值 ${formatBytes(WORKER_SCRIPT_WARN_BYTES)}，僅為進入點檔案）`,
      });
    } else {
      add({
        id: "worker-size",
        title: "Worker 指令碼大小",
        level: "advisory",
        status: "skip",
        detail: `找不到進入點 ${main}`,
      });
    }
  }

  const blocked = checks.some((check) => check.level === "critical" && check.status === "fail");
  const needsConfirmation = checks.some((check) => check.level === "confirm" && check.status === "fail");

  return { checks, blocked, needsConfirmation };
}

/**
 * @param {{ checks: CheckResult[], blocked: boolean, needsConfirmation?: boolean }} result
 * @returns {string}
 */
export function renderChecks(result) {
  const symbols = { pass: "[通過]", fail: "[失敗]", skip: "[略過]" };
  const marks = { critical: "重大", confirm: "需確認", advisory: "提醒" };

  const lines = result.checks.map((check) => {
    const mark = marks[check.level] ?? "提醒";

    return `${symbols[check.status]} ${check.title}（${mark}）：${check.detail}`;
  });

  lines.push("");

  // 三種結論的優先序：擋 > 待確認 > 可部署。
  // 「需確認」不是失敗，但也不是通過——它是「等人做決定」，
  // 因此結論必須明確要求動作，不能含糊地說「可以部署了」。
  if (result.blocked) {
    lines.push("有重大項目未通過，**不可部署**。修正後再檢查一次。");
  } else if (result.needsConfirmation === true) {
    lines.push("沒有重大項目失敗，但**有需要你確認的檔案**（見上方「需你確認的檔案」）。");
    lines.push("逐項確認後才可部署：可以上傳的寫進放行清單，不該上傳的移出專案資料夾。");
  } else {
    lines.push("沒有重大項目失敗，可以進入部署。");
  }

  return lines.join("\n");
}
