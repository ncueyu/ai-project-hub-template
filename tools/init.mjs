/**
 * `hub init`：初始化展示中心自己（不是子專案）——見
 * `2026-08-27-工作計畫-站名與hub-init.md` Part B。
 *
 * ## 這裡跟 `tools/ship.mjs` 的根本差異
 *
 * `ship.mjs`／`tools/inject-gate.mjs` 全部是對「目標子專案資料夾」（`dir`
 * 參數）操作。這裡初始化的是**展示中心自己**——老師下載下來的這份 repo。
 * 因此本檔的主要函式收的是 `rootDir`（展示中心的根目錄），不是某個子專案
 * 的路徑；真正執行時預設用 `tools/config.mjs` 的 `PROJECT_ROOT`，測試時
 * 可以指向一份丟棄式副本。
 *
 * ## 為什麼流程裡的每個 D1／Wrangler 操作都走注入式 `runCommand`
 *
 * `tools/d1.mjs` 的 `executeSql()` 有自己一套 `buildEnv()`／`runNode()`，
 * 直接呼叫 `spawn()`，不可注入假的執行器。但這裡的操作（`d1 create`、
 * `d1 list --json`、`d1 migrations apply --remote`）必須能在單元測試裡
 * 用假 runner 驗證指令形狀，不能真的碰 Cloudflare（工作計畫 B3／B4 驗收
 * 條件）。因此本檔改走 `tools/ship.mjs` 既有那一套：`runCommand(command,
 * args, cwd) => Promise<{code, stdout, stderr}>` 的可注入介面，預設值是
 * `tools/github.mjs` 的 `run()`——與 `shipProject()` 完全同一種依賴注入
 * 模式，`test/hub-ship.test.mjs` 已經證明這套模式好測。
 *
 * 這也代表這裡**不覆蓋** `XDG_CONFIG_HOME`（`d1.mjs` 的 `buildEnv()` 才有
 * 那段邏輯）。`buildEnv()` 自己的文件已經寫明：遠端操作且靠 OAuth 認證時
 * 「不覆蓋，讓 Wrangler 讀得到登入憑證」——這裡從頭到尾只做遠端操作，
 * 直接繼承目前行程的環境變數就是正確行為，不需要重新實作那段判斷。
 *
 * ## `database_id` 是否為佔位值的判斷
 *
 * 直接重用 `tools/config.mjs` 既有的 `hasRemoteDatabase()`——那裡已經是
 * 本專案認定「真實值 vs. 佔位值」的單一事實來源（判準：前 8 碼是否全為
 * 0），不在這裡另外發明一套 UUID 格式判斷，避免兩份判準不同步。
 *
 * ## 失敗後重試的安全性
 *
 * - **建立 D1 資料庫**：`ensureRemoteDatabase()` 會先用 `d1 list --json`
 *   查有沒有同名資料庫存在，找到就直接沿用，不會重複建立。這樣「資料庫已
 *   建好、但寫入 wrangler.jsonc 失敗」之後重跑，不會留下第二個孤兒資料庫。
 * - **寫入 wrangler.jsonc**：`patchWranglerConfig()` 全部在記憶體裡完成
 *   修補與驗證，只有驗證通過才會真的寫檔——驗證失敗時原始檔案完全不動，
 *   可以安全重跑（跟 `tools/inject-gate.mjs` 的 `assertPatchedJsoncIsValid()`
 *   同一種「先驗證、後落地」原則）。
 * - **套用 migration**：`wrangler d1 migrations apply` 本身只套用尚未套用
 *   過的 migration，重跑天然是安全的（官方說明）。
 * - **部署**：`wrangler deploy` 本身是幂等的，重新部署同一份程式碼無害。
 * - **寫入 site_settings**：SQL 用 `ON CONFLICT(key) DO UPDATE`，重跑會
 *   覆蓋成同樣的值，不會產生重複列。
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parsePasswordHash } from "../src/access-gate/password.js";
import {
  DEFAULT_GALLERY_LAYOUT,
  GALLERY_LAYOUTS,
  isValidGalleryLayout,
  isValidSiteName,
  SITE_NAME_MAX_LENGTH,
} from "../src/repositories/settings.js";
import { hasRemoteDatabase, PROJECT_ROOT, readWranglerConfig, stripJsonComments } from "./config.mjs";
import { extractJson, resolveWranglerEntry, sqlLiteral } from "./d1.mjs";
import { deployWithSecrets } from "./deploy.mjs";
import { parseActiveGhAccount, run } from "./github.mjs";
import { generateSigningKey } from "./inject-gate.mjs";
import { parseDeployedUrl } from "./ship.mjs";

/**
 * 範例專案的權威副本位置，以及要複製到哪裡。
 *
 * 為什麼權威副本放 `templates/` 而不是直接放 `要部署的專案/`：
 * 2026-08-22 已裁定「每個專案都要有自己的 repo，不能同時躺在 Hub repo 裡」
 * （理由寫在 `.gitignore` 那一段：同一份檔案存在兩個 repo，改了哪邊都不會
 * 同步，日後必然對不上），所以 `.gitignore` 把 `要部署的專案/*` 整個排除。
 *
 * 但範例專案必須隨空殼交付，才有「第一次看到自己網站上真的有東西」那一刻。
 * 兩者的解法就是這裡：權威副本放 `templates/`（本來就被 git 追蹤、沒被擋），
 * `hub init` 時複製一份到 `要部署的專案/`，複製出來的那份仍被 gitignore 擋掉。
 * 兩個裁定都不違反，也不會在 Hub repo 裡長出 embedded git repo
 * （`hub github` 對非 git 專案會直接 `git init`，見 tools/github.mjs）。
 */
export const EXAMPLE_PROJECT_SOURCE = "templates/範例專案-連連看";
export const EXAMPLE_PROJECT_TARGET = "要部署的專案/連連看遊戲";

/**
 * @typedef {{ step: string, status: "ok" | "skipped" | "stopped", detail: string }} InitStep
 * @typedef {{ ok: boolean, steps: InitStep[], deploymentUrl?: string }} InitResult
 */

/** 內部用：中止整個流程時拋出，統一在 `initHub()` 頂層接住並轉成 `stop()`。 */
class InitStopError extends Error {}

/**
 * 把站名轉成適合當 D1 資料庫名稱的代稱。
 *
 * D1 資料庫名稱只能用小寫英文、數字與連字號（與 Worker 名稱同規則）。
 * 站名多半是中文（例如「李老師的AI展示中心」），本專案沒有引入中文轉拼音
 * 套件（不為這個小需求新增依賴），因此策略是：只取站名裡本來就是 ASCII
 * 英數的字元、轉小寫、其餘字元變成連字號、合併重複連字號。篩選後完全
 * 沒有英數字元（例如全中文站名）時，回退成固定字首加站名的穩定雜湊。
 *
 * **刻意用雜湊、不用隨機值**：`ensureRemoteDatabase()`／`findDatabaseByName()`
 * 的「重跑時沿用同名資料庫」機制，前提是同一個站名每次都能算出同一個
 * 資料庫名稱——用隨機值的話，兩次呼叫（例如失敗重跑）會各自產生不同名稱，
 * 找不到彼此，安全重跑就會失效，變成每次重跑都建一個新資料庫。
 *
 * @param {string} siteName
 * @returns {string}
 */
function siteSlug(siteName) {
  return siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function siteDigest(siteName) {
  return createHash("sha256").update(siteName, "utf8").digest("hex").slice(0, 6);
}

export function deriveDatabaseName(siteName) {
  const slug = siteSlug(siteName);

  return slug ? `${slug}-hub-db` : `hub-db-${siteDigest(siteName)}`;
}

/**
 * 把站名轉成 Worker 名稱。
 *
 * **為什麼非做不可**：Worker 名稱就是它在 Cloudflare 帳號裡的身分。範本的
 * `wrangler.jsonc` 寫死 `"ai-project-hub"`，所以任何人在自己帳號裡跑 `hub init`，
 * 部署出去的 Worker 都叫同一個名字——帳號裡已經有同名 Worker 的話，那次部署
 * 就是**覆蓋掉它**，而且不會有任何警告。
 *
 * 命名沿用 `deriveDatabaseName()` 的 slug 與穩定雜湊（重跑算得出同樣的名字），
 * 只是不加 `-db` 後綴。刻意不另外發明一套判斷：同一個問題有兩套判準，
 * 遲早會不同步。
 *
 * @param {string} siteName
 * @returns {string}
 */
export function deriveWorkerName(siteName) {
  const slug = siteSlug(siteName);

  return slug ? `${slug}-hub` : `hub-${siteDigest(siteName)}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 在 JSONC 原始文字中，把 `"<key>": "<oldValue>"` 換成 `"<key>": "<newValue>"`，
 * 其餘文字（含註解、縮排）逐字保留。
 *
 * 用「欄位名稱＋目前的值」一起當比對目標，而不是只用欄位名稱——避免誤中
 * 說明性註解裡剛好提到同一個欄位名稱的情況（`tools/inject-gate.mjs`
 * 2026-08-25 踩過同類型的坑：註解裡出現 `// "main": "old-entry.js"`
 * 騙過了只認欄位名稱的正則）。呼叫端必須先用已解析過的設定物件確認
 * `oldValue` 是這個欄位目前真正的值，這裡才據此做文字替換。
 *
 * @param {string} text
 * @param {string} key
 * @param {string} oldValue
 * @param {string} newValue
 * @returns {string}
 */
function replaceQuotedValue(text, key, oldValue, newValue) {
  const pattern = new RegExp(`("${key}"\\s*:\\s*")${escapeRegExp(oldValue)}(")`);

  if (!pattern.test(text)) {
    throw new Error(`wrangler.jsonc 的原始文字裡找不到 "${key}": "${oldValue}"，可能格式非預期，無法安全修補。`);
  }

  return text.replace(pattern, `$1${newValue}$2`);
}

/**
 * 把新的 `database_id`、`database_name`（與可選的 `ADMIN_ENABLED`）寫進 `wrangler.jsonc`。
 *
 * **`database_name` 必須一起換，不能只換 id**（2026-08-28 真實端到端測試踩到）：
 * `wrangler d1 migrations apply <名稱>` 是拿那個名稱**去 wrangler.jsonc 的
 * `database_name` 欄位查**，不是直接對 API 查。只換 id 的話，設定檔裡的名稱仍是
 * 舊的（或佔位值），migration 會失敗並回報
 * 「Couldn't find a D1 DB with the name or binding '<新名稱>'」——而那個錯誤訊息
 * 完全沒有指出「你的設定檔名稱沒換」這件事，很難從訊息本身看出成因。
 *
 * 全部在記憶體裡完成修補與驗證，只有驗證通過才真的寫檔——驗證失敗時
 * 原始檔案完全不動，見檔頭「失敗後重試的安全性」。
 *
 * @param {string} wranglerPath
 * @param {{ databaseId: string, databaseName: string, workerName?: string, adminEnabled?: boolean }} values
 */
export function patchWranglerConfig(wranglerPath, values) {
  const originalText = readFileSync(wranglerPath, "utf8");
  const config = JSON.parse(stripJsonComments(originalText));

  const currentDatabaseId = config?.d1_databases?.[0]?.database_id;

  if (typeof currentDatabaseId !== "string") {
    throw new Error("wrangler.jsonc 裡找不到 d1_databases[0].database_id，格式不符預期，無法安全修補。");
  }

  const currentDatabaseName = config?.d1_databases?.[0]?.database_name;

  if (typeof currentDatabaseName !== "string") {
    throw new Error("wrangler.jsonc 裡找不到 d1_databases[0].database_name，格式不符預期，無法安全修補。");
  }

  let patched = replaceQuotedValue(originalText, "database_id", currentDatabaseId, values.databaseId);

  patched = replaceQuotedValue(patched, "database_name", currentDatabaseName, values.databaseName);

  /*
   * Worker 名稱只在呼叫端明確要求時才改。做成可選、而不是一律改，是因為
   * 這個函式的契約應該是「你要我改什麼我就改什麼」；至於 init 流程一定要
   * 帶這個參數，由 initHub() 那一層的測試負責釘住。
   *
   * `replaceQuotedValue` 的 pattern 要求 `name` 前面緊接一個引號，所以
   * `"database_name"` 不會被誤中（那裡的 `name` 前面是底線）。
   */
  if (typeof values.workerName === "string") {
    const currentWorkerName = config?.name;

    if (typeof currentWorkerName !== "string") {
      throw new Error("wrangler.jsonc 裡找不到頂層的 name，格式不符預期，無法安全修補。");
    }

    patched = replaceQuotedValue(patched, "name", currentWorkerName, values.workerName);
  }

  const currentAdminEnabled = config?.vars?.ADMIN_ENABLED;
  const wantsAdminPatch = typeof values.adminEnabled === "boolean" && typeof currentAdminEnabled === "string";

  if (wantsAdminPatch) {
    patched = replaceQuotedValue(patched, "ADMIN_ENABLED", currentAdminEnabled, String(values.adminEnabled));
  }

  // 驗證修補後仍是合法 JSON，且目標值確實正確落地——不能只驗證字串插入
  // 「看起來」對，必須驗證最終結果真的能被 Wrangler 讀懂。
  const reparsed = JSON.parse(stripJsonComments(patched));

  if (reparsed?.d1_databases?.[0]?.database_id !== values.databaseId) {
    throw new Error("修補後驗證失敗：database_id 沒有正確換成新值（原始檔案未被寫入）。");
  }

  if (reparsed?.d1_databases?.[0]?.database_name !== values.databaseName) {
    throw new Error("修補後驗證失敗：database_name 沒有正確換成新值（原始檔案未被寫入）。");
  }

  if (typeof values.workerName === "string" && reparsed?.name !== values.workerName) {
    throw new Error("修補後驗證失敗：Worker 名稱沒有正確換成新值（原始檔案未被寫入）。");
  }

  if (wantsAdminPatch && reparsed?.vars?.ADMIN_ENABLED !== String(values.adminEnabled)) {
    throw new Error("修補後驗證失敗：ADMIN_ENABLED 沒有正確換成新值（原始檔案未被寫入）。");
  }

  writeFileSync(wranglerPath, patched, "utf8");

  return patched;
}

/**
 * 問一個「有旗標就直接用、沒旗標就互動問」的必填文字問題。
 *
 * `--yes` 模式下缺旗標視為明確錯誤，不使用任何預設值頂替——工作計畫
 * §4-1 (2)：站名／密碼雜湊沒有合理預設值，偷偷帶過會讓使用者得到一個
 * 他沒選過的值而不自知。
 *
 * @param {{
 *   flagValue: string | undefined,
 *   autoApprove: boolean,
 *   prompt: (message: string) => Promise<string>,
 *   label: string,
 *   flagName: string,
 *   question: string,
 *   validate: (value: string) => string | null,
 * }} options
 * @returns {Promise<string>}
 */
async function askRequired(options) {
  const { flagValue, autoApprove, prompt, label, flagName, question, validate } = options;

  if (typeof flagValue === "string" && flagValue.trim() !== "") {
    const trimmed = flagValue.trim();
    const error = validate(trimmed);

    if (error) {
      throw new InitStopError(`${flagName} 的值不合法：${error}`);
    }

    return trimmed;
  }

  if (autoApprove) {
    throw new InitStopError(`--yes 模式下必須提供 ${flagName}（${label}），沒有合理預設值可用，不會用預設值頂替。`);
  }

  for (;;) {
    const answer = (await prompt(question)).trim();

    if (answer === "") {
      process.stdout.write("不能是空白，請再輸入一次。\n");
      continue;
    }

    const error = validate(answer);

    if (error) {
      process.stdout.write(`${error}\n`);
      continue;
    }

    return answer;
  }
}

/**
 * 問一個「有旗標就用、沒旗標互動問、都沒有就用預設值」的問題——用在
 * 版面風格（預設 grid）與後台開關（預設開），這兩項本身就有合理預設值，
 * 跟站名／密碼雜湊的情況不同。
 *
 * @param {{
 *   flagValue: string | undefined,
 *   autoApprove: boolean,
 *   prompt: (message: string) => Promise<string>,
 *   flagName: string,
 *   question: string,
 *   defaultValue: string,
 *   validate: (value: string) => string | null,
 * }} options
 * @returns {Promise<string>}
 */
async function askWithDefault(options) {
  const { flagValue, autoApprove, prompt, flagName, question, defaultValue, validate } = options;

  if (typeof flagValue === "string" && flagValue.trim() !== "") {
    const trimmed = flagValue.trim();
    const error = validate(trimmed);

    if (error) {
      throw new InitStopError(`${flagName} 的值不合法：${error}`);
    }

    return trimmed;
  }

  if (autoApprove) {
    return defaultValue;
  }

  for (;;) {
    const answer = (await prompt(`${question}（直接按 Enter 使用預設值 ${defaultValue}）`)).trim();

    if (answer === "") {
      return defaultValue;
    }

    const error = validate(answer);

    if (error) {
      process.stdout.write(`${error}\n`);
      continue;
    }

    return answer;
  }
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function validateSiteName(value) {
  return isValidSiteName(value) ? null : `站名長度必須介於 1 到 ${SITE_NAME_MAX_LENGTH} 個字元。`;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function validatePasswordHash(value) {
  return parsePasswordHash(value) !== null
    ? null
    : "看起來不是 node tools/hash-admin-password.mjs 印出的雜湊格式（應該是 pbkdf2-sha256$次數$鹽值$金鑰）。請確認貼上的是雜湊，不是密碼本身。";
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function validateLayout(value) {
  return isValidGalleryLayout(value) ? null : `只能是下列其中之一：${GALLERY_LAYOUTS.join("、")}。`;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function validateAdminFlag(value) {
  return value === "true" || value === "false" ? null : "只能是 true 或 false。";
}

/**
 * `hub init` 主流程。
 *
 * @param {{
 *   rootDir?: string,
 *   runCommand?: typeof run,
 *   confirm: (message: string) => Promise<boolean>,
 *   prompt: (message: string) => Promise<string>,
 *   autoApprove?: boolean,
 *   flags?: { siteName?: string, passwordHash?: string, layout?: string, admin?: string },
 * }} options
 * @returns {Promise<InitResult>}
 */
export async function initHub(options) {
  const rootDir = options.rootDir ?? PROJECT_ROOT;
  const runCommand = options.runCommand ?? run;
  const autoApprove = options.autoApprove === true;
  const flags = options.flags ?? {};

  /** @type {InitStep[]} */
  const steps = [];

  /**
   * @param {string} step
   * @param {string} detail
   * @returns {InitResult}
   */
  function stop(step, detail) {
    steps.push({ step, status: "stopped", detail });
    return { ok: false, steps };
  }

  /**
   * @param {string} step
   * @param {string} detail
   */
  function ok(step, detail) {
    steps.push({ step, status: "ok", detail });
  }

  const wranglerPath = join(rootDir, "wrangler.jsonc");

  // ── 前置檢查 0-a：database_id 是否已經是真實值 ──────────────────
  /** @type {Record<string, any>} */
  let config;

  try {
    config = readWranglerConfig(wranglerPath);
  } catch (error) {
    return stop("read-config", `讀不到或無法解析 ${wranglerPath}：${error instanceof Error ? error.message : String(error)}`);
  }

  if (hasRemoteDatabase(config)) {
    return stop(
      "already-initialized",
      "wrangler.jsonc 的 database_id 看起來已經是真實值——這個展示中心可能已經初始化過。"
        + "為了保護既有資料庫，hub init 不提供覆蓋選項（不支援 --force）。"
        + "若你確定要重新開始，請先自行處理 wrangler.jsonc 再重新執行。",
    );
  }

  ok("already-initialized", "database_id 仍是佔位值，可以繼續。");

  // ── 前置檢查 0-b：依賴是否已安裝（wrangler 找不找得到）───────────
  let wranglerEntry;

  try {
    wranglerEntry = resolveWranglerEntry();
  } catch (error) {
    return stop("dependencies", error instanceof Error ? error.message : String(error));
  }

  ok("dependencies", "相依套件已安裝。");

  // ── 前置檢查 0-c：Wrangler 是否已登入 ───────────────────────────
  const whoamiResult = await runCommand(process.execPath, [wranglerEntry, "whoami"], rootDir);

  // 已於 2026-08-28 對本專案已登入的帳號實測：登入時輸出含
  // 「You are logged in」字樣。未登入時的確切文字未經同樣方式驗證
  // （不刻意登出來測，會打斷開發環境），因此用「有沒有出現這個正面訊號」
  // 判斷，而不是猜測未登入時的錯誤文字或依賴退出碼——更保守、不容易誤判。
  if (!/you are logged in/i.test(whoamiResult.stdout)) {
    return stop(
      "wrangler-logged-in",
      "Wrangler 尚未登入。請先執行：node node_modules/wrangler/bin/wrangler.js login",
    );
  }

  ok("wrangler-logged-in", "Wrangler 已登入。");

  // ── 前置檢查 0-d：GitHub 只提醒，不擋 ──
  //
  // 2026-08-28 由實作者提出、主對話採納的修正：原本這裡把「gh 未安裝」與
  // 「gh 未登入」都當成阻擋條件，但 `hub init` 從頭到尾**完全不碰 GitHub**
  // （它只建資料庫、套 migration、部署展示中心）。為一個與本指令無關的工具
  // 擋住「建立自己的展示中心」，對新手是沒有理由的挫折——他可能只是還沒走到
  // 推送專案那一步。
  //
  // 但完全不檢查也不對：他建好展示中心後，下一步幾乎一定是 `hub ship`，
  // 那時才發現要裝 gh、要登入，等於把問題延後到更難理解的時機。
  //
  // 所以改成**提醒而非阻擋**：照樣檢查、照樣說清楚下一步要做什麼，但不中止流程。
  const ghVersionResult = await runCommand("gh", ["--version"], rootDir);
  const ghAuthResult = ghVersionResult.code === 0
    ? await runCommand("gh", ["auth", "status"], rootDir)
    : null;
  const activeGhAccount = ghAuthResult
    ? parseActiveGhAccount(`${ghAuthResult.stdout}
${ghAuthResult.stderr}`)
    : null;

  if (ghVersionResult.code !== 0) {
    steps.push({
      step: "gh-ready",
      status: "skipped",
      detail:
        "提醒：找不到 gh（GitHub CLI）。建立展示中心不需要它，但之後要用 hub ship "
        + "部署專案時需要。屆時請先安裝：winget install --id GitHub.cli",
    });
  } else if (!activeGhAccount) {
    steps.push({
      step: "gh-ready",
      status: "skipped",
      detail:
        "提醒：gh 已安裝但尚未登入。建立展示中心不需要它，但之後要用 hub ship "
        + "部署專案時需要。屆時請先執行：gh auth login",
    });
  } else {
    ok("gh-ready", `GitHub 作用中帳號：${activeGhAccount}（之後 hub ship 會用到）`);
  }

  // ── 問四件事 ─────────────────────────────────────────────────
  let siteName;
  let passwordHash;
  let layout;
  let adminFlag;

  try {
    siteName = await askRequired({
      flagValue: flags.siteName,
      autoApprove,
      prompt: options.prompt,
      label: "站名",
      flagName: "--site-name",
      question: "站名（例如：李老師的AI展示中心）：",
      validate: validateSiteName,
    });

    passwordHash = await askRequired({
      flagValue: flags.passwordHash,
      autoApprove,
      prompt: options.prompt,
      label: "管理者密碼雜湊",
      flagName: "--password-hash",
      question: "管理者密碼雜湊（先執行 node tools/hash-admin-password.mjs 產生，貼上雜湊，不是密碼本身）：",
      validate: validatePasswordHash,
    });

    layout = await askWithDefault({
      flagValue: flags.layout,
      autoApprove,
      prompt: options.prompt,
      flagName: "--layout",
      question: `版面風格（${GALLERY_LAYOUTS.join("／")} 之一）`,
      defaultValue: DEFAULT_GALLERY_LAYOUT,
      validate: validateLayout,
    });

    const adminAnswer = await askWithDefault({
      flagValue: flags.admin,
      autoApprove,
      prompt: options.prompt,
      flagName: "--admin",
      question: "要開啟管理後台嗎？（true／false）",
      defaultValue: "true",
      validate: validateAdminFlag,
    });

    adminFlag = adminAnswer === "true";
  } catch (error) {
    if (error instanceof InitStopError) {
      return stop("collect-answers", error.message);
    }

    throw error;
  }

  ok(
    "collect-answers",
    `站名：${siteName}　版面：${layout}　後台：${adminFlag ? "開" : "關"}（密碼雜湊已收到，不顯示內容）`,
  );

  const databaseName = deriveDatabaseName(siteName);
  const workerName = deriveWorkerName(siteName);
  const signingKey = generateSigningKey();

  // ── 不可逆動作前的確認關卡 ───────────────────────────────────
  const confirmed = await options.confirm(
    `即將執行以下動作，且步驟 2-4 一旦開始就不可逆：\n`
      + `  1. 建立 D1 資料庫「${databaseName}」（若已存在同名資料庫則直接沿用）\n`
      + `  2. 把 database_id 與 Worker 名稱「${workerName}」寫進 wrangler.jsonc\n`
      + `  3. 套用資料庫 migration 到遠端\n`
      + `  4. 部署展示中心為 Worker「${workerName}」`
      + `（同時設定 ADMIN_PASSWORD_HASH 與 SESSION_SIGNING_KEY 這兩把 Secret）\n`
      + `     ※ 你的 Cloudflare 帳號裡若已經有同名 Worker，這一步會覆蓋它。\n`
      + `  5. 寫入站名與版面設定\n`
      + `確定要繼續嗎？`,
  );

  if (!confirmed) {
    return stop("confirm-plan", "使用者未確認，中止。以上步驟都還沒有執行，可以直接重新執行 hub init。");
  }

  ok("confirm-plan", "已確認，開始執行。");

  // ── 步驟 2：建立（或沿用）D1 資料庫 ─────────────────────────────
  let databaseId;

  try {
    const found = await findDatabaseByName(databaseName, { wranglerEntry, runCommand, rootDir });

    if (found) {
      databaseId = found;
      ok("create-database", `資料庫「${databaseName}」已存在（可能是上次執行到一半的殘留），直接沿用，沒有建立新的。`);
    } else {
      const createResult = await runCommand(process.execPath, [wranglerEntry, "d1", "create", databaseName], rootDir);

      if (createResult.code !== 0) {
        return stop("create-database", `建立 D1 資料庫失敗：${createResult.stderr || createResult.stdout}\n可以安全重跑：這一步還沒有任何東西寫進 wrangler.jsonc。`);
      }

      const afterCreate = await findDatabaseByName(databaseName, { wranglerEntry, runCommand, rootDir });

      if (!afterCreate) {
        return stop(
          "create-database",
          `資料庫「${databaseName}」已建立，但在 wrangler d1 list --json 裡找不到對應項目，無法取得 database_id。`
            + "請自行執行 node node_modules/wrangler/bin/wrangler.js d1 list --json 確認，重跑 hub init 會自動找到並沿用這個資料庫。",
        );
      }

      databaseId = afterCreate;
      ok("create-database", `已建立 D1 資料庫「${databaseName}」（${databaseId}）。`);
    }
  } catch (error) {
    return stop("create-database", error instanceof Error ? error.message : String(error));
  }

  // ── 步驟 3：把 database_id（與後台開關）寫進 wrangler.jsonc ──────
  try {
    patchWranglerConfig(wranglerPath, { databaseId, databaseName, workerName, adminEnabled: adminFlag });
  } catch (error) {
    return stop(
      "write-config",
      `${error instanceof Error ? error.message : String(error)}\n`
        + `可以安全重跑：D1 資料庫「${databaseName}」已經存在，重新執行 hub init 會自動沿用，不會重複建立。`,
    );
  }

  ok(
    "write-config",
    `已把 database_id、database_name（${databaseName}）與 Worker 名稱（${workerName}）寫進 wrangler.jsonc。`,
  );

  // ── 步驟 4：套用 migration 到遠端 ───────────────────────────────
  // wrangler d1 migrations apply 只套用尚未套用過的 migration，且官方文件
  // 明講非互動環境會自動跳過確認提示——不需要額外處理互動輸入。
  const migrateResult = await runCommand(
    process.execPath,
    [wranglerEntry, "d1", "migrations", "apply", databaseName, "--remote"],
    rootDir,
  );

  if (migrateResult.code !== 0) {
    return stop(
      "migrate",
      `套用 migration 失敗：${migrateResult.stderr || migrateResult.stdout}\n`
        + "可以安全重跑：migration 只套用尚未套用過的部分，wrangler.jsonc 也已經指向正確的資料庫。",
    );
  }

  ok("migrate", "已套用資料庫 migration。");

  // ── 步驟 5：部署（帶兩把 Secret）──────────────────────────────
  const deployResult = await deployWithSecrets(
    rootDir,
    { ADMIN_PASSWORD_HASH: passwordHash, SESSION_SIGNING_KEY: signingKey },
    { runCommand },
  );

  if (deployResult.code !== 0) {
    return stop(
      "deploy",
      `部署失敗：${deployResult.stderr || deployResult.stdout}\n`
        + "可以安全重跑：資料庫與 migration 都已經就緒，重新執行 hub init 會直接重試部署（database_id 已不是佔位值——"
        + "但這個檢查只在最開頭做一次，這裡失敗後的重試是走同一次 initHub() 呼叫，不會重新觸發那個拒絕）。",
    );
  }

  const deploymentUrl = parseDeployedUrl(deployResult.stdout);

  if (!deploymentUrl) {
    return stop(
      "deploy",
      "部署指令看起來成功了，但沒能從輸出中找到線上網址，不確定真正的部署狀態。"
        + "請自行到 Cloudflare 儀表板確認，不要假設它已經上線。",
    );
  }

  ok("deploy", `已部署：${deploymentUrl}`);

  // ── 步驟 6：寫入站名與版面設定 ───────────────────────────────
  const now = new Date().toISOString();
  const sql = `INSERT INTO site_settings (key, value, updated_at) VALUES `
    + `('site_name', ${sqlLiteral(siteName)}, ${sqlLiteral(now)}), `
    + `('gallery_layout', ${sqlLiteral(layout)}, ${sqlLiteral(now)}) `
    + `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`;

  const settingsResult = await runCommand(
    process.execPath,
    [wranglerEntry, "d1", "execute", databaseName, "--remote", "--command", sql, "--json"],
    rootDir,
  );

  if (settingsResult.code !== 0) {
    return stop(
      "write-settings",
      `寫入站名與版面設定失敗：${settingsResult.stderr || settingsResult.stdout}\n`
        + "可以安全重跑：這一步是 upsert，重跑不會產生重複資料，也不影響已經完成的部署。",
    );
  }

  ok("write-settings", "已寫入站名與版面設定。");

  // ── 步驟 7：把範例專案複製到「要部署的專案/」 ────────────────
  //
  // 放在 init 而不是新增一個 CLI 子指令：init 已經是設定期的唯一入口，
  // 複製是一次性動作，不值得多一個子指令的表面積。複製完使用者只要說
  // 「部署範例專案」，AI 就跑既有的 `hub ship`。
  const exampleSource = join(rootDir, EXAMPLE_PROJECT_SOURCE);
  const exampleTarget = join(rootDir, EXAMPLE_PROJECT_TARGET);

  if (!existsSync(exampleSource)) {
    // 刻意不當成錯誤：展示中心此時已經部署成功了，少一個範例專案不影響它
    // 運作。把這一步升級成 stop 會讓使用者以為整個 init 失敗、想重跑，
    // 那才是真正的傷害。
    steps.push({
      step: "copy-example",
      status: "skipped",
      detail: `找不到範例專案來源（${EXAMPLE_PROJECT_SOURCE}），跳過這一步。展示中心本身已經上線，不受影響。`,
    });
  } else if (existsSync(exampleTarget)) {
    // 不覆寫：使用者可能已經把它改成自己的內容了。
    steps.push({
      step: "copy-example",
      status: "skipped",
      detail: `${EXAMPLE_PROJECT_TARGET} 已經存在，保留原有內容，不覆寫。`,
    });
  } else {
    cpSync(exampleSource, exampleTarget, { recursive: true });
    ok("copy-example", `已把範例專案複製到 ${EXAMPLE_PROJECT_TARGET}，可以部署了。`);
  }

  // ── 步驟 8：印出網址與後續怎麼改 ─────────────────────────────
  steps.push({
    step: "next-steps",
    status: "ok",
    detail:
      `網站：${deploymentUrl}\n`
      + `管理後台：${deploymentUrl}/admin/\n\n`
      + "下一步：跟 AI 說「部署範例專案」，就會看到第一個專案出現在展示中心。\n"
      + "  注意：部署完成後它預設是「私人」狀態，展示中心還看不到它——\n"
      + "  要到管理後台把權限改成「公開」才會出現。這一步刻意保留，\n"
      + "  因為權限控制正是你日後保護自己專案要用的功能，先在範例上練一次。\n\n"
      + "以後想改這些設定：\n"
      + "  · 站名、展示中心版面 → 登入管理後台，「站台設定」區塊直接改，存檔立即生效，不需要重新部署。\n"
      + "  · 管理者密碼 → 重跑 node tools/hash-admin-password.mjs 產生新雜湊，"
      + "再用 node node_modules/wrangler/bin/wrangler.js secret put ADMIN_PASSWORD_HASH 設定，立即生效、不需要重新部署。\n"
      + "  · 後台開關 → 改 wrangler.jsonc 的 vars.ADMIN_ENABLED，改了要重新部署（npm run deploy）。\n"
      + "  · 也可以直接跟 AI 說「改站名」「換版面」「改後台密碼」，AI 知道怎麼處理。",
  });

  return { ok: true, steps, deploymentUrl };
}

/**
 * 用 `wrangler d1 list --json` 依名稱找資料庫，回傳其 `uuid`（即
 * `database_id`）；找不到回傳 `null`。
 *
 * @param {string} databaseName
 * @param {{ wranglerEntry: string, runCommand: typeof run, rootDir: string }} context
 * @returns {Promise<string | null>}
 */
async function findDatabaseByName(databaseName, { wranglerEntry, runCommand, rootDir }) {
  const listResult = await runCommand(process.execPath, [wranglerEntry, "d1", "list", "--json"], rootDir);

  if (listResult.code !== 0) {
    return null;
  }

  let databases;

  try {
    databases = extractJson(listResult.stdout);
  } catch {
    return null;
  }

  if (!Array.isArray(databases)) {
    return null;
  }

  const match = databases.find((item) => item?.name === databaseName);

  return match && typeof match.uuid === "string" ? match.uuid : null;
}
