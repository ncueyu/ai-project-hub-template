/**
 * `hub ship`：串起 GitHub 推送、密碼閘道注入、Cloudflare 部署、Hub 資料庫登錄。
 *
 * 依 `2026-08-25-工作計畫.md` 階段 C 規格。範圍刻意限縮：**只處理靜態專案**
 * （`plan.kind === "static"`）。遇到已經有自己 `main` 的 Worker 型專案，
 * 停下來、不自動處理——把新程式碼合併進別人已寫好的邏輯風險太高。
 *
 * ## 步驟順序，以及為什麼是這個順序（不是規格草稿原本寫的順序）
 *
 * 草稿原本設想「推 GitHub → 注入閘道 → 部署 → 登錄資料庫」。實作時發現一個
 * 順序問題：閘道設定檔裡要寫死 `project_id`，這個值要跟資料庫的真實 id
 * 一致，否則簽發出去的工作階段永遠驗不過（`verifySession` 會比對它）。
 * 但新專案的 id 只有登錄過資料庫才會有——形成「注入需要 id，id 需要登錄，
 * 登錄照原順序又排在注入之後」的循環。
 *
 * 解法：把「確保資料庫裡有這個專案的位子」拆成獨立的一步
 * （`ensureProjectRegistered`，只確保 id 存在，不記錄部署本身），排在
 * **推送 GitHub 之後、注入閘道之前**。這樣：
 *   1. 使用者的確認關卡（`publishToGithub` 自己的步驟 0）仍然是整個流程
 *      第一個會發生的事，不會在使用者按下確認前就先寫資料庫或動檔案。
 *   2. 拿到真實 id 後才產生閘道設定，設定值從頭到尾是對的，不需要事後修補。
 *   3. 閘道注入的檔案會是**獨立的第二個 commit**（推送 GitHub 之後才產生），
 *      好處是留下清楚的軌跡：「這是你的程式碼」與「這是 Hub 自動加的保護」
 *      分得開，而不是為了湊成一個 commit 而讓兩者混在一起。
 *
 * ## `password` 專案（2026-08-29 起支援）
 *
 * 密碼雜湊存在 Hub 自己的 `project_policies` 表，部署時透過
 * `deployWithSecrets()` 注入成目標專案的 `PROJECT_PASSWORD_HASH`
 * （閘道讀的就是這個，見 `inject-gate.mjs`）。
 *
 * 讀取管道刻意獨立成 `tools/policy-secret.mjs` 而不是加進 `queries.mjs`：
 * 後者的檔頭明訂「完全不查詢 `project_policies`」，理由是它的輸出會經由 MCP
 * 進入 AI 的脈絡。那條界線必須保留，所以雜湊走的是一條單向窄管道——
 * 讀出來之後直接進 `--secrets-file`，**不進任何步驟訊息、log 或 `--json` 輸出**。
 *
 * 權限是 `password` 但還沒設定密碼時**停止部署**，不當成「沒有保護」照樣送出去：
 * 那會做出一個宣稱受保護、實際上誰都打得開的網站，而使用者以為它鎖著。
 *
 * ## 2026-09-04：權限與密碼都改成即時生效，不再需要重新部署
 *
 * 這裡原本寫著「密碼是部署當下注入的，所以在後台改密碼之後必須重新部署才會
 * 生效」。那句話已經不成立。閘道現在直接查 Hub 的 D1（見
 * `src/access-gate/policy-lookup.js`），權限、密碼、policy_version 三者都是
 * 即時的；`--secrets-file` 送上去的雜湊只剩下「D1 連不上時的後援」這一個用途。
 *
 * 改動的起因是一個實際踩到的失敗：使用者在後台把專案改成公開，展示中心的
 * 卡片出現了、點進去卻是 404，而重新部署也修不好（舊版對不需要閘道的權限
 * 整段跳過注入）。細節見下方注入那一段的說明。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MANIFEST_FILENAME, parseManifest } from "../src/hub/manifest.js";
import { planBuild } from "./build-plan.mjs";
import { deployWithSecrets } from "./deploy.mjs";
import { readPasswordHash } from "./policy-secret.mjs";
import { publishToGithub, run } from "./github.mjs";
import {
  ensureHubDbBinding,
  generateSigningKey,
  injectGate,
  isOwnGateAlreadyInjected,
  readHubDatabase,
  rewriteGateEntry,
} from "./inject-gate.mjs";
import { ensureProjectRegistered, registerDeployment } from "./register.mjs";
import { detectLinkFolder } from "./link-detect.mjs";
import { getProject } from "./queries.mjs";
import { findThumbnailSource } from "./thumbnail.mjs";
import { storeThumbnailFromFile } from "./thumbnail-store.mjs";

/** 目前固定為 1。若之後需要讓某個專案的所有工作階段一次失效，才需要遞增——
 *  目前沒有介面可以改這個值，先寫死，等真的需要再補。 */
const GATE_POLICY_VERSION = 1;

/**
 * 把閘道相關的檔案變更 commit 並推上去。
 *
 * 抽成共用函式是因為有兩條路徑會用到：第一次注入閘道，以及權限改變後重寫
 * 進入點。兩者的錯誤處理必須一致——漏推的後果一樣（GitHub 上的程式碼與線上
 * 部署的內容不一致），沒有理由讓其中一條的檢查比較鬆。
 *
 * @param {(command: string, args: string[], cwd?: string) => Promise<{ code: number, stdout: string, stderr: string }>} runCommand
 * @param {string} dir
 * @param {string} message
 * @returns {Promise<{ ok: true } | { ok: false, detail: string }>}
 */
async function commitGateChanges(runCommand, dir, message) {
  const addResult = await runCommand("git", ["add", "-A"], dir);

  if (addResult.code !== 0) {
    return { ok: false, detail: `git add 失敗：${addResult.stderr || addResult.stdout}` };
  }

  const commitResult = await runCommand("git", ["commit", "-m", message], dir);

  if (commitResult.code !== 0) {
    return { ok: false, detail: `git commit 失敗：${commitResult.stderr || commitResult.stdout}` };
  }

  const pushResult = await runCommand("git", ["push"], dir);

  if (pushResult.code !== 0) {
    return { ok: false, detail: `git push 失敗：${pushResult.stderr || pushResult.stdout}` };
  }

  return { ok: true };
}

/** `wrangler deploy` 成功時會印出這一行（原文見 wrangler 原始碼
 *  `logger.log(" ", target)`），用它取得真正的線上網址，不自己猜子網域。 */
const DEPLOY_URL_PATTERN = /^\s*(https:\/\/\S*\.workers\.dev\S*)\s*$/m;

/**
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseDeployedUrl(stdout) {
  const match = stdout.match(DEPLOY_URL_PATTERN);

  return match ? match[1].trim() : null;
}

/**
 * @typedef {{ step: string, status: "ok" | "skipped" | "stopped", detail: string }} ShipStep
 * @typedef {{ ok: boolean, steps: ShipStep[], deploymentUrl?: string, visibility?: string }} ShipResult
 */

/**
 * @param {string} dir
 * @param {{
 *   confirm: (message: string) => Promise<boolean>,
 *   runCommand?: typeof run,
 *   runBuild?: boolean,
 *   runTests?: boolean,
 *   runTypecheck?: boolean,
 *   remote?: boolean,
 *   readPasswordHash?: typeof readPasswordHash,
 *   ensureProjectRegistered?: typeof ensureProjectRegistered,
 *   registerDeployment?: typeof registerDeployment,
 *   storeThumbnail?: typeof storeThumbnailFromFile,
 *   getProject?: typeof getProject,
 *   fetch?: typeof fetch,
 * }} options
 * @returns {Promise<ShipResult>}
 */
export async function shipProject(dir, options) {
  const runCommand = options.runCommand ?? run;
  const ensureProjectRegisteredFn = options.ensureProjectRegistered ?? ensureProjectRegistered;
  const registerDeploymentFn = options.registerDeployment ?? registerDeployment;
  const readPasswordHashFn = options.readPasswordHash ?? readPasswordHash;
  const storeThumbnailFn = options.storeThumbnail ?? storeThumbnailFromFile;
  const getProjectFn = options.getProject ?? getProject;
  const fetchFn = options.fetch ?? fetch;
  /** @type {ShipStep[]} */
  const steps = [];

  /**
   * @param {string} step
   * @param {string} detail
   * @returns {ShipResult}
   */
  function stop(step, detail) {
    steps.push({ step, status: "stopped", detail });
    return { ok: false, steps };
  }

  /*
   * ── 外部連結專案：在動任何外部資源之前就攔下來（2026-08-30）──
   *
   * 位置很重要，必須在 publishToGithub() **之前**。那個函式會建立 GitHub repo
   * 並推送——一個只有 txt 與截圖的資料夾就這樣變成一個實際存在的 repo，
   * 然後流程才在後面的範圍檢查失敗。使用者看到的是「失敗」，
   * 卻多了一個他從來沒要求過的 repo。
   *
   * 這個檢查只讀一次資料夾清單，成本可以忽略。
   */
  if (detectLinkFolder(dir).isLink) {
    return stop(
      "scope-check",
      "這是外部連結專案：資料夾裡只有一個寫著網址的文字檔，沒有網頁檔案。\n"
        + "那個網站已經在別的地方上線了，不需要也不應該由這裡重新部署，\n"
        + "所以還沒有推送到 GitHub、也沒有部署任何東西。\n"
        + `要把它加進展示中心（含預覽圖）請用：node bin/hub.mjs link ${dir}`,
    );
  }

  // ── 步驟 1-5：GitHub（確認、掃描、建置測試、推送）全部交給既有的 hub github ──
  const githubResult = await publishToGithub(dir, {
    confirm: options.confirm,
    runCommand,
    runBuild: options.runBuild,
    runTests: options.runTests,
    runTypecheck: options.runTypecheck,
  });

  steps.push(...githubResult.steps);

  if (!githubResult.ok) {
    return { ok: false, steps };
  }

  // ── 範圍檢查：只處理靜態專案 ──
  const manifestText = readFileSync(join(dir, MANIFEST_FILENAME), "utf8");
  const manifest = parseManifest(manifestText);

  if (!manifest.ok) {
    return stop("read-manifest", `${MANIFEST_FILENAME} 內容有問題，無法繼續。`);
  }

  const { name, slug } = manifest.value;
  const plan = planBuild(dir);

  // `plan.kind !== "static"` 不必然代表「這是別人的 Worker 型專案」——也可能
  // 是上一次 `hub ship` 已經把閘道注入成功、但接下來的 `wrangler deploy`
  // 失敗，重試時偵測到自己上次留下的 main／access-gate 痕跡。用
  // `isOwnGateAlreadyInjected()` 分辨這兩種狀況（見
  // `2026-08-26-工作計畫.md` 三、設計），只有真的不是自己的痕跡才拒絕。
  const isContinuation = plan.kind !== "static" && isOwnGateAlreadyInjected(dir);

  if (plan.kind !== "static" && !isContinuation) {
    return stop(
      "scope-check",
      `這個專案型態是 "${plan.kind}"，hub ship 目前只處理純靜態專案（"static"）。` +
        "已經有自己 main 的 Worker 型專案需要人工確認閘道怎麼接進既有邏輯，不會自動處理。",
    );
  }

  // 這個專案「本質上」是靜態專案，`plan.kind` 只是因為上次注入而暫時變成
  // "worker"——後續登錄資料庫時該記錄它本質上的型態，不該因為重試而寫錯。
  const effectiveKind = isContinuation ? "static" : plan.kind;

  steps.push({
    step: "scope-check",
    status: "ok",
    detail: isContinuation
      ? "偵測到先前已注入過閘道的痕跡（main 指向 hub-gate-entry.js），視為接續執行，不是別人的 Worker 專案。"
      : "靜態專案，可以繼續。",
  });

  // ── 確保資料庫裡有這個專案的位子，取得真實 id（見檔頭說明的順序理由） ──
  let registered;

  try {
    registered = await ensureProjectRegisteredFn(
      { name, slug, platform: "cloudflare", project_type: effectiveKind },
      { remote: options.remote },
    );
  } catch (error) {
    return stop("ensure-registered", error instanceof Error ? error.message : String(error));
  }

  steps.push({
    step: "ensure-registered",
    status: "ok",
    detail: `${registered.isNew ? "新建立" : "找到既有"}專案，id=${registered.projectId}，visibility=${registered.visibility}。`,
  });

  /*
   * 權限是「需要密碼」時，把 Hub 資料庫裡的密碼雜湊帶下來，稍後隨部署注入成
   * 目標專案的 `PROJECT_PASSWORD_HASH`（閘道讀的就是這個，見 inject-gate.mjs）。
   *
   * 【嚴禁】把這個值放進任何步驟訊息、錯誤訊息或 --json 輸出。雜湊出現在終端機
   * 輸出，就等於出現在使用者與 AI 的對話裡——`tools/policy-secret.mjs` 的檔頭
   * 說明了這條界線，`test/ship-password.test.mjs` 有測試在盯它。
   */
  /** @type {string | null} */
  let passwordHashForDeploy = null;

  if (registered.visibility === "password") {
    try {
      passwordHashForDeploy = await readPasswordHashFn(registered.projectId, { remote: options.remote });
    } catch (error) {
      return stop("read-password", `讀取密碼設定失敗：${error instanceof Error ? error.message : String(error)}`);
    }

    if (!passwordHashForDeploy) {
      /*
       * 權限設成「需要密碼」但還沒真的設密碼，是後台允許的中間狀態
       * （可以先改權限、之後才輸入密碼）。這時**必須停下**——照樣部署會產生一個
       * 宣稱受保護、實際上誰都打得開的網站，而使用者以為它是鎖著的。
       * 這是「以為有保護但其實沒有」那一類最危險的失敗，不能只是警告。
       */
      return stop(
        "read-password",
        "這個專案的權限是「需要密碼」，但還沒有設定密碼。\n"
          + "請先到管理後台的「密碼設定」輸入密碼，再重新執行這道部署指令。\n"
          + "（沒有密碼就部署，會做出一個看起來有保護、其實誰都能開的網站。）",
      );
    }

    steps.push({
      // 只說有沒有拿到，不說內容也不說長度。
      step: "read-password",
      status: "ok",
      detail: "已取得這個專案的密碼設定，稍後隨部署一起注入。",
    });
  }

  /*
   * ── 權限閘道注入（一律注入），並推送第二個 commit ──
   *
   * ## 為什麼從「只有需要保護時才注入」改成「一律注入」（2026-09-04）
   *
   * 原本這裡是 `if (needsGateInjection(registered.visibility))`，公開專案
   * 整段跳過。那造成兩件事：
   *
   *   ① 公開專案沒有 Worker，也就沒有任何東西會去查它現在的權限。使用者
   *      在後台把專案改成公開之後，線上仍然是舊的烙印權限（404），而且
   *      **重新部署也修不好**——因為新權限是 public，這個判斷仍然是 false，
   *      連 2026-08-29 加的「權限變了就重寫進入點」都跑不到。
   *      2026-09-04 使用者在新電腦實測時就是撞到這個。
   *
   *   ② 判斷本身沒有安全上的必要性：`requiresAccessGate()` 說的是「這個
   *      狀態要不要對訪客設限」，不是「要不要有能力設限」。而權限隨時會變，
   *      設定檔卻是部署當下就固定的。
   *
   * 代價已與使用者確認：公開專案的靜態請求從免費無上限變成計入 Worker
   * 每日額度（見 `src/visibility.js` 的 `runWorkerFirstFor()`）。
   */
  /** @type {string | null} 有值時，部署時要連同這把金鑰一起上傳。 */
  let signingKeyForDeploy = null;

  /** @type {{ databaseName: string, databaseId: string }} */
  let hubDatabase;

  try {
    hubDatabase = readHubDatabase();
  } catch (error) {
    return stop("inject-gate", error instanceof Error ? error.message : String(error));
  }

  if (isContinuation) {
    // 上一次已經成功注入過（`wrangler.jsonc`、`hub-gate-entry.js`、
    // `access-gate/` 都在），再呼叫一次 `injectGate()` 只會撞上它自己
    // 「main 已存在」的保護。上一次部署沒有成功完成，金鑰從未真正透過
    // `--secrets-file` 上傳到 Cloudflare，不存在「相容性」問題，重新生
    // 一把即可，不需要也不該重複 commit／push。
    signingKeyForDeploy = generateSigningKey();

    /*
     * 進入點**無條件重寫**，不比對權限有沒有變（2026-09-04 改）。
     *
     * 原本這裡先用 `readInjectedVisibility()` 比對現場烙的權限、不一樣才
     * 重寫。權限改成即時查詢之後，檔案裡烙的值只是後援，比對已經沒有意義；
     * 而且比對本身也是 bug 的一部分（外層那個「不需要閘道就整段跳過」讓它
     * 連跑到的機會都沒有）。重寫一個小檔案沒有成本，少一個判斷就少一條
     * 會漏掉的路徑。
     *
     * `ensureHubDbBinding()` 是給**舊專案**的：2026-09-04 之前注入的閘道
     * 沒有 D1 綁定，而這條路不會呼叫 `injectGate()`（會撞上 main 已存在的
     * 保護），所以綁定要單獨補。沒補的話閘道查不到權限、安靜地回退到烙印
     * 值——網站看起來正常，只是權限不會即時生效，且沒有任何錯誤訊息。
     */
    rewriteGateEntry(dir, {
      projectId: registered.projectId,
      visibility: registered.visibility,
      policyVersion: GATE_POLICY_VERSION,
      projectName: name,
    });

    let bindingAdded = false;

    try {
      bindingAdded = ensureHubDbBinding(dir, hubDatabase);
    } catch (error) {
      return stop("inject-gate", error instanceof Error ? error.message : String(error));
    }

    const rewriteCommit = await commitGateChanges(
      runCommand,
      dir,
      `hub ship: 更新閘道（權限：${registered.visibility}）`,
    );

    if (!rewriteCommit.ok) {
      return stop("commit-gate", rewriteCommit.detail);
    }

    steps.push({
      step: "inject-gate",
      status: "ok",
      detail: bindingAdded
        ? `已更新閘道進入點，並補上 Hub 資料庫綁定（舊版部署缺這一項，補上後權限才會即時生效）。目前權限：${registered.visibility}。`
        : `已更新閘道進入點。目前權限：${registered.visibility}（權限改動不需要重新部署，這裡只是同步檔案）。`,
    });
  } else {
    let injected;

    try {
      injected = injectGate(dir, {
        projectId: registered.projectId,
        visibility: registered.visibility,
        policyVersion: GATE_POLICY_VERSION,
        projectName: name,
        database: hubDatabase,
      });
    } catch (error) {
      return stop("inject-gate", error instanceof Error ? error.message : String(error));
    }

    steps.push({
      step: "inject-gate",
      status: "ok",
      detail: `已注入權限閘道（含 Hub 資料庫綁定，之後在後台改權限會即時生效）。目前權限：${registered.visibility}。`,
    });

    const addResult = await runCommand("git", ["add", "-A"], dir);

    if (addResult.code !== 0) {
      return stop("commit-gate", `git add 失敗：${addResult.stderr || addResult.stdout}`);
    }

    const commitResult = await runCommand(
      "git",
      ["commit", "-m", "hub ship: 注入密碼閘道"],
      dir,
    );

    if (commitResult.code !== 0) {
      return stop("commit-gate", `git commit 失敗：${commitResult.stderr || commitResult.stdout}`);
    }

    const pushResult = await runCommand("git", ["push"], dir);

    if (pushResult.code !== 0) {
      return stop("commit-gate", `git push 失敗：${pushResult.stderr || pushResult.stdout}`);
    }

    steps.push({ step: "commit-gate", status: "ok", detail: "已推送閘道設定（獨立的第二個 commit）。" });
    signingKeyForDeploy = injected.signingKey;
  }

  // ── 部署（簽章金鑰隨部署一起上傳，不用另外互動輸入） ──
  //
  // 部署機制（--secrets-file、暫存目錄、EFTYPE 陷阱）已抽到
  // tools/deploy.mjs 的 deployWithSecrets()——2026-08-28 工作計畫
  // §4-1 (1)：hub init 需要同時部署兩把 Secret，原本寫死一把的版本
  // 沒辦法共用，因此一般化成收 Record<string, string>。這裡沒有簽章金鑰
  // 時傳空物件，行為與抽取前完全相同（不建立暫存檔、不帶 --secrets-file）。
  const deploySecrets = {
    ...(signingKeyForDeploy ? { SESSION_SIGNING_KEY: signingKeyForDeploy } : {}),
    ...(passwordHashForDeploy ? { PROJECT_PASSWORD_HASH: passwordHashForDeploy } : {}),
  };

  const deployResult = await deployWithSecrets(dir, deploySecrets, { runCommand });

  if (deployResult.code !== 0) {
    return stop(
      "deploy",
      `部署失敗：${deployResult.stderr || deployResult.stdout}\n` +
        "程式碼已經推上 GitHub，可以安全重試部署，不需要重新 commit。",
    );
  }

  const deploymentUrl = parseDeployedUrl(deployResult.stdout);

  if (!deploymentUrl) {
    return stop(
      "deploy",
      "部署指令看起來成功了，但沒能從輸出中找到線上網址，不確定真正的部署狀態。" +
        "請自行到 Cloudflare 儀表板確認，不要假設它已經上線。",
    );
  }

  steps.push({ step: "deploy", status: "ok", detail: `已部署：${deploymentUrl}` });

  // ── 登錄 Hub 資料庫（此時專案已確定存在，走既有的更新路徑） ──
  const shaResult = await runCommand("git", ["rev-parse", "HEAD"], dir);
  const versionRef = shaResult.code === 0 ? shaResult.stdout.trim() : null;

  let finalRegistration;

  try {
    finalRegistration = await registerDeploymentFn(
      {
        name,
        slug,
        platform: "cloudflare",
        project_type: effectiveKind,
        repository_url: githubResult.repoUrl,
        worker_name: slug,
        deployment_url: deploymentUrl,
        version_ref: versionRef,
        /*
         * 這裡**不送** thumbnail_url（2026-08-30 改）。縮圖改由下面那一段
         * 直接寫進 D1，`storeThumbnailFromFile()` 自己會更新這個欄位。
         * 在這裡也送一份會變成兩處寫同一欄，日後一定會不一致。
         */
      },
      { remote: options.remote },
    );
  } catch (error) {
    return stop(
      "register",
      `${error instanceof Error ? error.message : String(error)}\n` +
        "網站已經上線，只是展示中心還沒列出它——重跑登錄即可，不用重新部署。",
    );
  }

  steps.push({
    step: "register",
    status: "ok",
    detail: `已登錄到 Hub 資料庫（id=${finalRegistration.projectId}）。`,
  });

  /*
   * ── 縮圖：把專案資料夾裡的截圖存進 D1 ──
   *
   * ## 為什麼從「複製進 public/thumbnails/」改成「存進 D1」（2026-08-30）
   *
   * 舊做法是把截圖複製成展示中心自己的靜態檔案。那有三個實際後果：
   *
   *   ① 圖只存在使用者的硬碟上，要再跑一次 `npm run deploy` 才會上線。
   *      而 hub thumbnail／hub link／後台上傳都是即時的——同一件事有兩種
   *      生效時機，AI 每次都得先判斷「這次要不要提醒重新部署」。
   *
   *   ② **會靜默蓋掉使用者在後台選的圖。** 舊做法把 thumbnail_url 交給
   *      registerDeployment()，只要專案資料夾裡有任何圖片就會覆蓋。於是
   *      「使用者在後台上傳了一張精挑的圖 → 過幾天改了網頁重新部署 →
   *      半年前那張舊截圖把它蓋回去」，而且沒有任何提示。
   *
   *   ③ 每張 100～250 KB 的截圖進展示中心的 git 歷史，永遠拿不掉。
   *
   * 改走 D1 之後三個都消失，而且與另外三條路徑用同一套機制。
   *
   * ## 為什麼移到登錄之後
   *
   * `storeThumbnailFromFile()` 需要 projectId，而且它自己會下 UPDATE。
   * 順序倒過來（先存圖再登錄）的話，中間失敗會留下「圖在 D1、但 projects
   * 那一列還沒建好」的狀態。
   *
   * 失敗不中斷整個流程：網站已經上線了，縮圖只是卡片上的一張圖，
   * 為了它把已經成功的部署標記成失敗是不成比例的。改成記一筆 warn。
   */
  const thumbnailSource = findThumbnailSource(dir);

  if (thumbnailSource !== null) {
    try {
      /*
       * 先查目前指到哪張圖，才能在換圖之後把舊的位元組刪掉。
       * 不刪的話每次重新部署都留下一份沒有人指向的孤兒，慢慢吃掉 D1 配額，
       * 而前端完全看不出來。查不到就當作沒有舊圖——多留一份孤兒，
       * 比為了清理而讓一次成功的部署變成失敗好。
       */
      let previousThumbnailUrl = null;

      try {
        previousThumbnailUrl = (await getProjectFn(slug, { remote: options.remote }))?.thumbnail_url ?? null;
      } catch {
        /* 查不到就跳過孤兒清理 */
      }

      const stored = await storeThumbnailFn({
        imagePath: thumbnailSource.path,
        projectId: finalRegistration.projectId,
        previousThumbnailUrl,
        remote: options.remote,
      });

      steps.push({
        step: "thumbnail",
        status: "ok",
        detail:
          `已把「${thumbnailSource.name}」設為這個專案的預覽圖`
          + `（${Math.round(stored.byteSize / 1024)} KB，分成 ${stored.chunkCount} 段存進資料庫）。\n`
          + "      縮圖存在資料庫裡，**不需要重新部署展示中心**，重新整理就看得到。",
      });
    } catch (error) {
      steps.push({
        step: "thumbnail",
        status: "warn",
        detail:
          `預覽圖設定失敗：${error instanceof Error ? error.message : String(error)}\n`
          + "      網站本身已經正常上線，只是卡片會顯示「此專案尚無預覽圖」。",
      });
    }
  }

  // ── 驗證：實際連線確認網站活著、狀態碼符合預期 ──
  const isPubliclyReachable = finalRegistration.visibility === "public" || finalRegistration.visibility === "unlisted";

  try {
    const response = await fetchFn(deploymentUrl);
    const expected = isPubliclyReachable ? 200 : 404;

    if (response.status !== expected) {
      steps.push({
        step: "verify",
        status: "stopped",
        detail: `連線確認狀態碼為 ${response.status}，預期 ${expected}（visibility=${finalRegistration.visibility}）。請自行檢查。`,
      });

      return { ok: false, steps, deploymentUrl, visibility: finalRegistration.visibility };
    }

    steps.push({ step: "verify", status: "ok", detail: `連線確認狀態碼 ${response.status}，符合預期。` });
  } catch (error) {
    steps.push({
      step: "verify",
      status: "stopped",
      detail: `無法連線確認：${error instanceof Error ? error.message : String(error)}`,
    });

    return { ok: false, steps, deploymentUrl, visibility: finalRegistration.visibility };
  }

  steps.push({
    step: "done",
    status: "ok",
    detail:
      `完成。網址：${deploymentUrl}\n` +
      `目前權限：${finalRegistration.visibility}` +
      (finalRegistration.visibility === "private" ? "（訪客一律看不到，要公開請到後台修改權限）" : ""),
  });

  return { ok: true, steps, deploymentUrl, visibility: finalRegistration.visibility };
}
