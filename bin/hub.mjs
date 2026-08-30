#!/usr/bin/env node

/**
 * hub CLI —— 階段 A 骨架 ＋ 階段 B（`github`）＋ 階段 C（`ship`）。
 *
 * 階段 A 的指令全部「只看不動」。`github` 與 `ship` 會改變外部狀態
 * （建立 GitHub repo、推送程式碼、部署、寫資料庫），因此是僅有內建互動
 * 確認機制的兩個指令；其餘唯讀指令刻意不提供任何會改變狀態的變體，
 * 寧可指令少，也不要出現「看起來能用、實際上沒接上」的指令。
 *
 * 用法一律走 `node bin/hub.mjs`，不依賴 PATH 上的任何東西。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { MANIFEST_FILENAME, parseManifest } from "../src/hub/manifest.js";
import { planBuild, renderPlan } from "../tools/build-plan.mjs";
import { hasRemoteDatabase } from "../tools/config.mjs";
import { detectProject } from "../tools/detect.mjs";
import { applyDomainLock } from "../tools/domain-lock.mjs";
import { publishToGithub } from "../tools/github.mjs";
import { listPitfalls, renderPitfalls, SCOPES } from "../tools/pitfalls.mjs";
import { renderChecks, runPreDeployChecks } from "../tools/predeploy.mjs";
import { getDeploymentStatus, getProject, listProjects } from "../tools/queries.mjs";
import { storeThumbnailFromFile } from "../tools/thumbnail-store.mjs";
import { initHub } from "../tools/init.mjs";
import { linkProject } from "../tools/link.mjs";
import { newProject } from "../tools/new-project.mjs";
import { shipProject } from "../tools/ship.mjs";

const USAGE = `hub —— AI Project Hub 指令列工具

用法：
  node bin/hub.mjs <指令> [選項]

指令：
  list                    列出專案
  status <代稱或編號>      顯示單一專案與最近的部署紀錄
  manifest [檔案路徑]      檢查 ${MANIFEST_FILENAME} 的內容是否正確
  detect [專案路徑]        判斷專案型態（不做任何修改）
  build --dry-run [路徑]   顯示建置計畫（不執行建置）
  check [專案路徑]         部署前檢查
  github [專案路徑]        推送專案到 GitHub（一律 private，不含部署、不含登錄展示中心）
  ship [專案路徑]          推送 ＋ 部署 ＋ 登錄展示中心（僅限靜態專案，見下方說明）
  init                    初始化展示中心自己（建 D1、部署、寫入站名與版面設定，見下方說明）
  new <資料夾>             把一個資料夾初始化成可部署的專案（建 public/、產生兩個設定檔）
  link <資料夾>            登錄一個已經在別的地方上線的網站（不部署、不需要後台密碼）
  lock <資料夾>            加一段檢查：頁面不是從自己的網址載入就不執行（--remove 移除）
  thumbnail <專案> <圖片>  把一張圖設成該專案的縮圖（存進 D1，不需要重新部署）
  pitfalls [情境]          列出已知的部署踩坑（每一項都是實際踩過才寫上來的）
  help                    顯示這份說明

選項：
  --remote                改用遠端 D1（list／status 等查詢指令預設為本機模擬資料庫）
  --local                 ship／link／thumbnail 用：改成只寫本機模擬資料庫。這三個
                          指令預設就是遠端，因為它們的目的都是改變線上看得到的東西
  --json                  以 JSON 輸出，供程式讀取
  --limit=<數字>           限制筆數（1-100）
  --visibility=<狀態>      只列出指定可見性的專案
  --skip-build            check 時不執行建置
  --skip-tests            check 時不執行測試
  --skip-typecheck        check 時不執行型別檢查
  --remove                lock 用：把已注入的網域鎖拿掉
  --yes                   github／ship／init 時跳過互動確認（阻擋級問題仍會停止，不會被跳過）
  --site-name=<文字>       init 用：站名（--yes 模式下必填，沒有合理預設值）
  --password-hash=<雜湊>   init 用：管理者密碼雜湊（--yes 模式下必填；不是密碼明文，
                          由 node tools/hash-admin-password.mjs 產生）
  --layout=<版面>          init 用：hero／grid／list／rows 之一，省略時預設 grid
  --admin=<true|false>    init 用：要不要開後台，省略時預設 true

ship 的限制：只處理純靜態專案（沒有自己 main 的 Worker）。新專案一律登錄為
private；已存在的專案不覆蓋目前的權限設定。若目前權限是「需要密碼」會停下來，
這一版尚未支援自動轉移密碼保護。

範例：
  node bin/hub.mjs list
  node bin/hub.mjs list --visibility=public
  node bin/hub.mjs status resistor-color-code
  node bin/hub.mjs manifest ./project-hub.json
  node bin/hub.mjs detect ../some-project
  node bin/hub.mjs build --dry-run ../some-project
  node bin/hub.mjs check ../some-project --skip-build
  node bin/hub.mjs github ../some-project
  node bin/hub.mjs ship ../some-project
  node bin/hub.mjs link 要部署的專案/我的班網
  node bin/hub.mjs lock 要部署的專案/我的測驗
  node bin/hub.mjs thumbnail resistor-color-code ./截圖.png
  node bin/hub.mjs init
`;

/**
 * @param {string[]} argv
 * @returns {{ command: string, positional: string[], flags: Record<string, string | boolean> }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  const positional = [];

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");

    if (eq === -1) {
      flags[body] = true;
    } else {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }

  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

/**
 * @param {Record<string, string | boolean>} flags
 */
function readCommonOptions(flags) {
  const options = { remote: flags.remote === true, json: flags.json === true };

  if (typeof flags.limit === "string") {
    Object.assign(options, { limit: Number(flags.limit) });
  }

  if (typeof flags.visibility === "string") {
    Object.assign(options, { visibility: flags.visibility });
  }

  return options;
}

/**
 * 資料來源說明。使用者最容易搞混的一點就是「我看到的是本機還是線上的資料」，
 * 所以每次輸出都明講。
 *
 * @param {boolean} remote
 * @returns {string}
 */
function describeSource(remote) {
  if (!remote) {
    return "資料來源：本機模擬資料庫（--local）";
  }

  return "資料來源：遠端 D1（--remote）";
}

/**
 * @param {Record<string, any>[]} projects
 */
function renderProjects(projects) {
  if (projects.length === 0) {
    return "（沒有符合條件的專案）";
  }

  const lines = projects.map((project) => {
    const category = project.category_name ? ` · ${project.category_name}` : "";
    const url = project.deployment_url ? `\n      ${project.deployment_url}` : "";

    return `  [${project.id}] ${project.name}（${project.slug}）\n`
      + `      ${project.visibility} · ${project.platform} · ${project.project_type}${category}${url}`;
  });

  return lines.join("\n");
}

/**
 * @param {{ project: Record<string, any>, deployments: Record<string, any>[] }} status
 */
function renderStatus(status) {
  const { project, deployments } = status;
  const lines = [
    `專案：${project.name}（${project.slug}，編號 ${project.id}）`,
    `可見性：${project.visibility}`,
    `平台：${project.platform} · 型態：${project.project_type} · 資料庫：${project.database_type}`,
    `線上網址：${project.deployment_url ?? "（尚未部署）"}`,
    `最後部署時間：${project.last_deployed_at ?? "（無）"}`,
    "",
    "部署紀錄：",
  ];

  if (deployments.length === 0) {
    lines.push("  （尚無紀錄）");
  } else {
    for (const item of deployments) {
      lines.push(
        `  ${item.created_at} · ${item.status} · ${item.platform}`
          + `${item.version_ref ? ` · ${item.version_ref}` : ""}\n      ${item.deployment_url}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * 建立互動確認函式。`--yes` 情境下自動回 true（供腳本／CI 使用），
 * 但這**不影響**阻擋級問題的處理——那個判斷在 `publishToGithub` 內部，
 * 與是否有人按 y 完全無關，`--yes` 只是跳過「等你輸入」這個動作本身。
 *
 * @param {boolean} autoApprove
 * @returns {(message: string) => Promise<boolean>}
 */
function createConfirm(autoApprove) {
  return async function confirm(message) {
    process.stdout.write(`\n${message}\n`);

    if (autoApprove) {
      process.stdout.write("（--yes，自動同意）\n");
      return true;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      const answer = await rl.question("繼續嗎？(y/n) ");
      return answer.trim().toLowerCase() === "y";
    } finally {
      rl.close();
    }
  };
}

/**
 * 建立自由文字輸入函式，供沒有合理預設值的問題使用（例如站名、密碼雜湊）。
 * 與 createConfirm() 的差異：這裡問的是文字內容，不是 y/n，因此**沒有**
 * `--yes` 自動帶過的邏輯——這種問題該不該在 `--yes` 模式下被跳過、跳過時
 * 該怎麼處理，由呼叫端（`tools/init.mjs`）自行決定（見工作計畫 §4-1 (2)：
 * 站名沒有合理預設值，`--yes` 缺少對應旗標時必須明確報錯停止，不能悄悄
 * 呼叫這個函式、拿到空字串後蒙混過去）。
 *
 * @returns {(message: string) => Promise<string>}
 */
/**
 * 建立一個可以連續問多題的 prompt。
 *
 * ## 為什麼不用 `rl.question()`（2026-08-29 修正的既有 bug）
 *
 * 原本的寫法是「每問一題就建一個 readline 介面、問完就 close」。在真實終端機
 * （TTY）下沒問題，但**只要輸入是管線餵進來的，第二題起就永遠不會回應**。
 *
 * 成因：readline 在非 TTY 時會把管線裡的所有行一次讀出來並發成 `line` 事件，
 * 而 `question()` 只接住呼叫當下的下一行——其餘的行在沒有接收者的情況下被丟掉，
 * 於是第二次 `question()` 等一個永遠不會來的東西。
 *
 * 症狀特別惡劣：在 `main()` 裡 await 一個永不 settle 的 Promise，事件迴圈一空
 * Node 就**靜默結束並回傳 0**。呼叫端（AI、腳本）會以為成功了，但流程其實停在
 * 半路。2026-08-29 實測 `hub new` 就是這樣搬完檔案卻沒產生設定檔而「成功」結束。
 *
 * 這對 `hub init` 更危險——它要問四題，而且會建立 D1 資料庫並部署。
 *
 * 修法是改用 readline 的 async iterator，它會正確緩衝行；輸入用完時回空字串
 * （讓呼叫端走預設值或自己停下），而不是無限等待。
 */
function createPrompt() {
  /** @type {import("node:readline/promises").Interface | null} */
  let rl = null;
  /** @type {AsyncIterator<string> | null} */
  let lines = null;

  const prompt = async function prompt(message) {
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      lines = rl[Symbol.asyncIterator]();
    }

    process.stdout.write(`${message} `);

    const next = await lines.next();
    return next.done ? "" : next.value;
  };

  /** 用完要關，否則 readline 會讓 stdin 一直被參照，程序不會結束。 */
  prompt.close = () => {
    rl?.close();
    rl = null;
    lines = null;
  };

  return prompt;
}

/**
 * @param {import("../tools/github.mjs").PublishStep[]} steps
 */
function renderPublishSteps(steps) {
  /*
   * `warn` 是 2026-08-30 由 ship 的縮圖步驟引入的，但當時漏了加進這張表——
   * 於是那一行會印成「undefined thumbnail」。缺少的鍵一律退回 [注意] 而不是
   * 讓 undefined 出現在使用者眼前：印錯字比漏掉一整段訊息容易發現，
   * 但兩者都不該發生。
   */
  const marks = { ok: "[完成]", skipped: "[略過]", stopped: "[停止]", warn: "[注意]" };

  return steps
    .map((step) => `${marks[step.status] ?? "[注意]"} ${step.step}\n${step.detail}`)
    .join("\n\n");
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} 結束代碼
 */
/**
 * 哪些指令**不吃**位置參數。
 *
 * 為什麼需要這個：`init` 分支原本完全不讀 `positional`，整支 CLI 也沒有任何
 * 多餘參數的檢查。於是 `hub init 要部署的專案/我的網頁` 會**靜默丟掉那個路徑**，
 * 然後去跑展示中心的完整初始化——建 D1 資料庫、改 wrangler.jsonc、
 * **部署到 Cloudflare**。使用者不會得到任何警告。
 *
 * 這個組合特別危險，因為 `init <資料夾>` 正是「初始化一個待部署專案」最自然的
 * 猜法（2026-08-26 的缺口盤點原本就是這樣提議的）。真正做那件事的指令是
 * `hub new <資料夾>`；打錯的代價不該是意外部署。
 */
const COMMANDS_WITHOUT_POSITIONAL = Object.freeze({
  init:
    "`init` 是初始化**展示中心自己**（會建立資料庫並部署到 Cloudflare），不接受資料夾參數。\n"
    + "要把一個資料夾變成可以部署的專案，請用：node bin/hub.mjs new <資料夾>",
  list: "`list` 不接受參數。要看單一專案請用：node bin/hub.mjs status <專案代稱或編號>",
});

/**
 * 檢查指令有沒有收到它不該收的位置參數。
 *
 * 抽成純函式而不是寫在 main() 裡，是為了能安全地測試：直接測
 * `main(["init", "某路徑"])` 的話，守衛一旦失效（例如做反向測試時）就會真的
 * 去執行 initHub——建資料庫、部署。測試不該有這種可能性。
 *
 * @param {string} command
 * @param {string[]} positional
 * @returns {string | null} 該報的錯誤訊息；沒問題時回 null
 */
export function rejectUnexpectedPositional(command, positional) {
  if (positional.length === 0) return null;

  const message = COMMANDS_WITHOUT_POSITIONAL[command];
  if (!message) return null;

  return `${command} 不接受「${positional.join(" ")}」這樣的參數。\n\n${message}`;
}

/**
 * 決定這次要用遠端還是本機 D1。
 *
 * `ship` 預設走**遠端**，其他指令沿用旗標（預設本機）。
 *
 * 2026-08-29 修正的缺陷：原本全部指令一律 `flags.remote === true`，而
 * `AGENTS.md` 教的指令是 `hub ship 要部署的專案/XXX`（沒有 --remote）。
 * 於是照文件走的人，專案會**真的**推上 GitHub、**真的**部署到 Cloudflare，
 * 但登錄卻寫進本機模擬資料庫——他打開自己的展示中心看不到那個專案，進後台也
 * 找不到它，根本無從把權限改成公開。失敗完全靜默：部署每一步都顯示成功。
 *
 * 只有 `ship` 改預設，是因為它與其他指令性質不同：`list`／`status` 是查詢，
 * 本機預設很合理；但 `ship` 從頭到尾都在動真實的外部資源，唯獨登錄寫本機
 * 是不一致的。
 *
 * 抽成純函式是為了能測——直接測 `main(["ship", dir])` 會真的執行部署。
 *
 * @param {string} command
 * @param {Record<string, string | boolean>} flags
 * @param {boolean} fallback `readCommonOptions()` 依旗標算出的值
 * @returns {boolean}
 */
export function resolveRemote(command, flags, fallback) {
  /*
   * `thumbnail` 與 `ship` 同一個理由（2026-08-30 加入）：使用者（或 AI）跑
   * `hub thumbnail my-quiz 截圖.png` 是為了讓縮圖出現在**線上**的展示中心。
   * 若沿用本機預設，圖會被寫進本機模擬資料庫，指令印出「已設定」，
   * 而線上完全沒有變化——又是一次沒有錯誤訊息的失敗。
   */
  if (command === "ship" || command === "thumbnail" || command === "link") {
    return flags.local !== true;
  }

  return fallback;
}

export async function main(argv) {
  const { command, positional, flags } = parseArgs(argv);

  if (command === "help" || flags.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const unexpected = rejectUnexpectedPositional(command, positional);

  if (unexpected) {
    process.stderr.write(`${unexpected}\n`);
    return 1;
  }

  const options = readCommonOptions(flags);

  /*
   * `ship` 預設走遠端 D1，其他指令沿用旗標（預設本機）。
   *
   * 2026-08-29 修正的缺陷：原本全部指令一律 `remote: flags.remote === true`，
   * 而 `AGENTS.md` 教的指令是 `hub ship 要部署的專案/XXX`（沒有 --remote）。
   * 於是照文件走的人，專案會**真的**推上 GitHub、**真的**部署到 Cloudflare，
   * 但登錄卻寫進本機模擬資料庫——他打開自己的展示中心看不到那個專案，
   * 進後台也找不到它，根本無從把權限改成公開。失敗是完全靜默的：
   * 部署每一步都顯示成功。
   *
   * 會這樣是因為 `ship` 與其他指令的性質不同：`list`／`status` 是查詢，
   * 本機預設很合理；但 `ship` 從頭到尾都在動真實的外部資源，唯獨登錄寫本機
   * 是不一致的。所以只有它改預設。
   */
  options.remote = resolveRemote(command, flags, options.remote);

  if (options.remote && !hasRemoteDatabase()) {
    process.stderr.write(
      "遠端 D1 尚未建立：wrangler.jsonc 的 database_id 仍是佔位值。\n"
        + "請先建立遠端資料庫並填入真實的 database_id，或拿掉 --remote 改看本機資料。\n",
    );
    return 1;
  }

  if (command === "list") {
    const projects = await listProjects(options);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`${describeSource(options.remote)}\n\n${renderProjects(projects)}\n`);
    return 0;
  }

  if (command === "status") {
    const identifier = positional[0];

    if (!identifier) {
      process.stderr.write("請指定專案代稱或編號，例如：node bin/hub.mjs status my-project\n");
      return 1;
    }

    const status = await getDeploymentStatus(identifier, options);

    if (!status) {
      process.stderr.write(`找不到專案：${identifier}\n`);
      return 1;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`${describeSource(options.remote)}\n\n${renderStatus(status)}\n`);
    return 0;
  }

  if (command === "manifest") {
    const path = resolve(positional[0] ?? MANIFEST_FILENAME);
    let text;

    try {
      text = readFileSync(path, "utf8");
    } catch {
      process.stderr.write(`讀不到檔案：${path}\n`);
      return 1;
    }

    const result = parseManifest(text);

    if (!result.ok) {
      process.stderr.write(`${MANIFEST_FILENAME} 有問題：\n`);

      for (const [field, message] of Object.entries(result.fields)) {
        process.stderr.write(`  ${field === "_" ? "整份檔案" : field}：${message}\n`);
      }

      return 1;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`${MANIFEST_FILENAME} 檢查通過（已填入預設值）：\n`);

    for (const [field, value] of Object.entries(result.value)) {
      process.stdout.write(`  ${field}：${value}\n`);
    }

    return 0;
  }

  if (command === "detect") {
    const dir = resolve(positional[0] ?? ".");
    const detection = detectProject(dir);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(detection, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`專案路徑：${dir}\n`);
    process.stdout.write(`判斷結果：${detection.kind}\n`);
    process.stdout.write(`打包工具：${detection.bundler ?? "（無）"}\n`);
    process.stdout.write(`套件管理器：${detection.packageManager ?? "（無）"}\n`);
    process.stdout.write(`建置指令：${detection.hasBuildScript ? "有" : "無"}\n`);
    process.stdout.write(`判斷依據：${detection.evidence.length > 0 ? detection.evidence.join("、") : "（無明確特徵）"}\n`);

    return detection.kind === "unknown" ? 1 : 0;
  }

  if (command === "build") {
    // 實際建置屬於階段 C。這裡只允許 --dry-run，避免出現「看起來能用、
    // 其實沒接上」的指令。
    if (flags["dry-run"] !== true) {
      process.stderr.write(
        "實際建置與部署屬於階段 C，目前尚未提供。\n"
          + "現在可以用：node bin/hub.mjs build --dry-run [專案路徑]\n",
      );
      return 1;
    }

    const dir = resolve(positional[0] ?? ".");
    const plan = planBuild(dir);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`專案路徑：${dir}\n\n${renderPlan(plan)}\n`);

    return plan.blockers.length > 0 ? 1 : 0;
  }

  if (command === "check") {
    const dir = resolve(positional[0] ?? ".");
    const result = await runPreDeployChecks(dir, {
      runBuild: flags["skip-build"] !== true,
      runTests: flags["skip-tests"] !== true,
      runTypecheck: flags["skip-typecheck"] !== true,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.blocked ? 1 : 0;
    }

    process.stdout.write(`專案路徑：${dir}\n\n${renderChecks(result)}\n`);

    return result.blocked ? 1 : 0;
  }

  if (command === "github") {
    const dir = resolve(positional[0] ?? ".");
    const autoApprove = flags.yes === true;

    const result = await publishToGithub(dir, { confirm: createConfirm(autoApprove) });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }

    process.stdout.write(`專案路徑：${dir}\n\n${renderPublishSteps(result.steps)}\n\n`);

    if (result.ok) {
      process.stdout.write(`完成。${result.repoUrl ?? ""}\n`);
      return 0;
    }

    process.stderr.write("未完成——見上方逐項結果，找「[停止]」那一項的說明。\n");
    return 1;
  }

  if (command === "ship") {
    const dir = resolve(positional[0] ?? ".");
    const autoApprove = flags.yes === true;

    const result = await shipProject(dir, { confirm: createConfirm(autoApprove), remote: options.remote });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }

    process.stdout.write(`專案路徑：${dir}\n\n${renderPublishSteps(result.steps)}\n\n`);

    if (result.ok) {
      process.stdout.write(`完成。${result.deploymentUrl ?? ""}\n`);
      return 0;
    }

    process.stderr.write("未完成——見上方逐項結果，找「[停止]」那一項的說明。\n");
    return 1;
  }

  if (command === "new") {
    const dir = positional[0];

    if (!dir) {
      process.stderr.write("請指定資料夾，例如：node bin/hub.mjs new 要部署的專案/我的網頁\n");
      return 1;
    }

    // 這支會搬動使用者既有的檔案，所以【不提供】--yes 跳過確認的路徑：
    // 「改動使用者既有檔案」依 AGENTS.md 第 3 節必須逐次取得同意。
    const prompt = createPrompt();

    try {
      const result = await newProject({
        dir: resolve(dir),
        confirm: createConfirm(false),
        prompt,
      });

      process.stdout.write(`${renderPublishSteps(result.steps)}\n`);
      return result.ok ? 0 : 1;
    } finally {
      prompt.close();
    }
  }

  if (command === "link") {
    const dir = positional[0];

    if (!dir) {
      process.stderr.write(
        "請指定資料夾，例如：node bin/hub.mjs link 要部署的專案/我的班網\n\n"
          + "那個資料夾裡要有一個寫著網址的文字檔（檔名不拘），\n"
          + "想一併設定預覽圖的話再放一張截圖進去。\n",
      );
      return 1;
    }

    /*
     * 與 `new` 一樣不提供 `--yes`：這會在展示中心上新增一張卡片，
     * 而名稱、代稱、說明都是要人看過的。跳過確認省下的時間，
     * 遠不及事後要進後台改正的麻煩。
     */
    const prompt = createPrompt();

    /*
     * 確認也走同一個 prompt，**不用 createConfirm()**。
     *
     * `createConfirm()` 每次呼叫都自己開一個新的 readline 介面。在真實終端機
     * 沒問題，但 `link` 是先問三題再確認——而 createPrompt() 的介面在非 TTY
     * （AI 或腳本用管線餵答案）時，早就把管線裡的所有行讀進自己的緩衝區了。
     * 那時候第二個介面拿不到任何東西，`繼續嗎？` 會等一個永遠不會來的答案。
     *
     * 這與 createPrompt() 檔頭記的是同一個坑，只是換一個形狀出現：
     * 一支程式對同一個 stdin 只能有一個讀取者。
     */
    const confirm = async (message) => {
      process.stdout.write(`\n${message}\n`);

      const answer = await prompt("繼續嗎？(y/n)");

      return answer.trim().toLowerCase() === "y";
    };

    try {
      const result = await linkProject({
        dir: resolve(dir),
        confirm,
        prompt,
        remote: options.remote,
      });

      process.stdout.write(`${renderPublishSteps(result.steps)}\n`);

      if (result.ok) {
        /*
         * 這段話是強制的，理由與 ship 相同（AGENTS.md「部署完成後你一定要說的話」）：
         * 新專案一律登錄為 private，所以使用者現在打開展示中心**還是看不到它**。
         * 不主動講，他會以為指令失敗了。
         */
        process.stdout.write(
          `\n已經登錄好了，但這個專案目前是**私人**狀態，展示中心還看不到它。\n`
            + `請到管理後台把「${result.slug}」的權限改成「公開」，重新整理展示中心就會出現。\n`
            + "（權限一律預設私人是刻意的：忘記設定的結果應該是沒人看得到，不是全世界都看得到。）\n",
        );
      }

      return result.ok ? 0 : 1;
    } finally {
      prompt.close();
    }
  }

  if (command === "init") {
    const autoApprove = flags.yes === true;

    const prompt = createPrompt();

    const result = await initHub({
      confirm: createConfirm(autoApprove),
      prompt,
      autoApprove,
      flags: {
        siteName: typeof flags["site-name"] === "string" ? flags["site-name"] : undefined,
        passwordHash: typeof flags["password-hash"] === "string" ? flags["password-hash"] : undefined,
        layout: typeof flags.layout === "string" ? flags.layout : undefined,
        admin: typeof flags.admin === "string" ? flags.admin : undefined,
      },
    });

    // initHub 回來之後不會再問任何問題，這裡直接關掉；不關的話 readline 會讓
    // stdin 一直被參照，程序不會結束。
    prompt.close();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }

    process.stdout.write(`${renderPublishSteps(result.steps)}\n\n`);

    if (result.ok) {
      process.stdout.write(`完成。${result.deploymentUrl ?? ""}\n`);
      return 0;
    }

    process.stderr.write("未完成——見上方逐項結果，找「[停止]」那一項的說明。\n");
    return 1;
  }

  if (command === "lock") {
    const dir = positional[0];

    if (!dir) {
      process.stderr.write(
        "請指定專案資料夾，例如：node bin/hub.mjs lock 要部署的專案/我的測驗\n\n"
          + "這個指令會在該專案的 HTML 裡加一段檢查：頁面不是從自己的網址載入時就不執行。\n"
          + "加上 --remove 則是把它拿掉。\n",
      );
      return 1;
    }

    const projectDir = resolve(dir);
    const manifestPath = join(projectDir, MANIFEST_FILENAME);

    if (!existsSync(manifestPath)) {
      process.stderr.write(
        `${projectDir} 底下找不到 ${MANIFEST_FILENAME}。\n`
          + "網域鎖要知道這個專案的代稱（線上網址的第一段），那個值寫在設定檔裡。\n"
          + `還沒有設定檔的話，先執行：node bin/hub.mjs new ${dir}\n`,
      );
      return 1;
    }

    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));

    if (!manifest.ok) {
      process.stderr.write(`${MANIFEST_FILENAME} 內容有問題，無法繼續。\n`);
      return 1;
    }

    const removing = flags.remove === true;

    try {
      const result = applyDomainLock({ dir: projectDir, slug: manifest.value.slug, remove: removing });
      const changed = result.files.filter((file) => file.changed);

      if (result.files.length === 0) {
        process.stderr.write(`${result.assetsDir} 底下找不到任何 HTML 檔案。\n`);
        return 1;
      }

      process.stdout.write(
        `${removing ? "已移除" : "已加入"}網域鎖：${changed.length}／${result.files.length} 個 HTML 檔案有變動\n`
          + `  目錄：${result.assetsDir}\n`
          + changed.map((file) => `  · ${file.path}\n`).join(""),
      );

      if (!removing) {
        /*
         * 這段話是強制的。這個功能最危險的失敗模式不是它壞掉，而是使用者
         * 以為它是「保護」——那會讓他把真正該保密的東西（例如測驗答案）
         * 安心地留在網頁裡。
         */
        process.stdout.write(
          "\n這是**嚇阻**，不是保護：\n"
            + "  · 擋得住「把整包複製回去、雙擊 index.html 打開」\n"
            + "  · 擋不住看得懂這段程式碼、把它刪掉的人\n"
            + "  · 原始碼一樣看得到——按 F12 或檢視原始碼都還是看得到\n\n"
            + "真的不能外流的東西（例如測驗答案）不要放進網頁，要放在伺服器那一邊。\n"
            + "本機測試（localhost）不受影響。改完要重新部署才會生效。\n",
        );
      }

      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (command === "thumbnail") {
    const identifier = positional[0];
    const imagePath = positional[1];

    if (!identifier || !imagePath) {
      process.stderr.write(
        "用法：node bin/hub.mjs thumbnail <專案代稱或編號> <圖片路徑>\n"
          + "例如：node bin/hub.mjs thumbnail my-quiz 截圖.png\n",
      );
      return 1;
    }

    const project = await getProject(identifier, options);

    if (!project) {
      process.stderr.write(`找不到專案：${identifier}\n`);
      return 1;
    }

    if (!existsSync(imagePath)) {
      process.stderr.write(`找不到圖片檔案：${imagePath}\n`);
      return 1;
    }

    try {
      const result = await storeThumbnailFromFile({
        imagePath,
        projectId: project.id,
        previousThumbnailUrl: project.thumbnail_url,
        remote: options.remote,
      });

      const kb = Math.round(result.byteSize / 1024);

      process.stdout.write(
        `已設定「${project.name}」的縮圖。\n`
          + `  格式：${result.contentType}，大小：${kb} KB，分成 ${result.chunkCount} 段存進資料庫\n`
          + `  網址：${result.thumbnailUrl}\n\n`
          + "縮圖存在資料庫裡，**不需要重新部署**，重新整理展示中心就看得到。\n",
      );

      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (command === "pitfalls") {
    const scope = positional[0] ?? "";
    const items = listPitfalls({ scope });

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ scopes: SCOPES, pitfalls: items }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`${renderPitfalls(items)}\n`);

    return items.length === 0 ? 1 : 0;
  }

  process.stderr.write(`不認得的指令：${command}\n\n${USAGE}`);
  return 1;
}

// 只有被直接執行時才跑；被 import 時（例如測試）不會有副作用。
// 用 pathToFileURL 而不是自行拼接字串——Windows 的磁碟機代號與反斜線
// 手工組出來的 file:// 網址不會與 import.meta.url 相等。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
