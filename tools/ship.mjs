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
 * 附帶的時序限制：密碼是**部署當下**注入的，所以在後台改密碼之後必須重新部署
 * 才會生效。後台與 `AGENTS.md` 都有對應的提醒。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MANIFEST_FILENAME, parseManifest } from "../src/hub/manifest.js";
import { planBuild } from "./build-plan.mjs";
import { deployWithSecrets } from "./deploy.mjs";
import { readPasswordHash } from "./policy-secret.mjs";
import { publishToGithub, run } from "./github.mjs";
import {
  generateSigningKey,
  injectGate,
  isOwnGateAlreadyInjected,
  needsGateInjection,
  readInjectedVisibility,
  rewriteGateEntry,
} from "./inject-gate.mjs";
import { ensureProjectRegistered, registerDeployment } from "./register.mjs";

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
 *   fetch?: typeof fetch,
 * }} options
 * @returns {Promise<ShipResult>}
 */
export async function shipProject(dir, options) {
  const runCommand = options.runCommand ?? run;
  const ensureProjectRegisteredFn = options.ensureProjectRegistered ?? ensureProjectRegistered;
  const registerDeploymentFn = options.registerDeployment ?? registerDeployment;
  const readPasswordHashFn = options.readPasswordHash ?? readPasswordHash;
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
          + "請先到管理後台的「密碼設定」輸入密碼，再重新部署。\n"
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

  // ── 密碼閘道注入（僅需要時），並推送第二個 commit ──
  /** @type {string | null} 有值時，部署時要連同這把金鑰一起上傳。 */
  let signingKeyForDeploy = null;

  if (needsGateInjection(registered.visibility)) {
    if (isContinuation) {
      // 上一次已經成功注入過（`wrangler.jsonc`、`hub-gate-entry.js`、
      // `access-gate/` 都在），再呼叫一次 `injectGate()` 只會撞上它自己
      // 「main 已存在」的保護。上一次部署沒有成功完成，金鑰從未真正透過
      // `--secrets-file` 上傳到 Cloudflare，不存在「相容性」問題，重新生
      // 一把即可，不需要也不該重複 commit／push。
      signingKeyForDeploy = generateSigningKey();

      /*
       * 但有一種情況不能只是跳過：**權限在兩次部署之間改變了**。
       *
       * 進入點檔案裡烙著產生當下的 visibility（見 renderGateEntry）。專案第一次
       * 以 private 部署、之後在後台改成 password 再重新部署時，這條路會讓現場
       * 的閘道繼續用 private 的邏輯——密碼雜湊確實注入了，但閘道不看它，
       * 訪客拿到 404 而不是密碼輸入頁。功能等於沒做出來，而且每一步都顯示成功。
       *
       * 2026-08-29 的真實端到端測試就是這樣抓到的；單元測試涵蓋不到，
       * 因為它需要「先部署、改權限、再部署」這個順序。
       */
      const injectedVisibility = readInjectedVisibility(dir);

      if (injectedVisibility !== null && injectedVisibility !== registered.visibility) {
        rewriteGateEntry(dir, {
          projectId: registered.projectId,
          visibility: registered.visibility,
          policyVersion: GATE_POLICY_VERSION,
          projectName: name,
        });

        const rewriteCommit = await commitGateChanges(
          runCommand,
          dir,
          `hub ship: 權限改為 ${registered.visibility}，更新閘道`,
        );

        if (!rewriteCommit.ok) {
          return stop("commit-gate", rewriteCommit.detail);
        }

        steps.push({
          step: "inject-gate",
          status: "ok",
          detail: `權限已從 ${injectedVisibility} 改為 ${registered.visibility}，重新產生閘道進入點並推送。`,
        });
      } else {
        steps.push({
          step: "inject-gate",
          status: "skipped",
          detail: "偵測到先前已注入過閘道檔案且權限未變，不重複寫入；重新產生簽章金鑰供這次部署使用。",
        });
      }
    } else {
      let injected;

      try {
        injected = injectGate(dir, {
          projectId: registered.projectId,
          visibility: registered.visibility,
          policyVersion: GATE_POLICY_VERSION,
          projectName: name,
        });
      } catch (error) {
        return stop("inject-gate", error instanceof Error ? error.message : String(error));
      }

      steps.push({ step: "inject-gate", status: "ok", detail: `已注入密碼閘道，權限：${registered.visibility}。` });

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
  } else {
    steps.push({ step: "inject-gate", status: "skipped", detail: `${registered.visibility} 不需要閘道。` });
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
