/**
 * hub github —— 只把一個專案的程式碼推到 GitHub，不含部署、不含 Hub 資料庫登錄。
 *
 * 這是 `hub` 家族第一個會改變外部狀態的指令（見 `bin/hub.mjs` 檔頭說明）。
 * 設計依據：`2026-08-24-工作計畫.md` 階段 B 規格，三個決定已定案——
 * 一律 private（不提供公開選項）、撞名時停下來問而不強推、remote 指向錯帳號要停下來。
 *
 * ## 為什麼不重用 `tools/predeploy.mjs` 的 `run()`
 *
 * 那裡用 `shell: true` 是安全的，因為指令字串全部來自本專案的固定常數
 * （例如 `corepack pnpm run build`），檔頭註解也明講「若日後要接受外部提供的
 * 指令，這裡必須改成陣列形式」。這個檔案的引數含使用者提供的路徑與
 * `project-hub.json` 裡的 slug／name——不是我們寫的常數，理論上可能含
 * 空白、分號或反引號。所以一律用陣列參數＋`shell: false`，不走 shell 字串拼接。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MANIFEST_FILENAME, parseManifest } from "../src/hub/manifest.js";
import { renderChecks, runPreDeployChecks } from "./predeploy.mjs";

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} CommandResult
 */

/**
 * 執行外部指令並回傳結果，不丟例外。
 *
 * `code: 127` 同時代表「指令不存在」與「一般的非零結束碼 127」——呼叫端
 * 只需要判斷 `code !== 0`，不需要區分兩者：對使用者而言結論都是「這一步沒成功」。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Promise<CommandResult>}
 */
export function run(command, args, cwd) {
  return new Promise((resolve) => {
    let child;

    try {
      child = spawn(command, args, { cwd, shell: false });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    // spawn 的 "error" 事件代表指令本身無法啟動（例如 gh 沒安裝），
    // 跟指令啟動後回傳非零結束碼是不同的路徑，兩者都要處理。
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: stderr || (error instanceof Error ? error.message : String(error)) });
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * 解析 `gh auth status` 的輸出，找出目前作用中的帳號。
 *
 * 這台機器同時有多個帳號登入是實際情況（`ncueyu` 與 `gpge0805`），輸出格式是
 * 逐帳號一個區塊：
 *
 * ```
 * github.com
 *   ✓ Logged in to github.com account ncueyu (keyring)
 *   - Active account: true
 *   ...
 *   ✓ Logged in to github.com account gpge0805 (keyring)
 *   - Active account: false
 * ```
 *
 * 找不到任何「Active account: true」時回傳 null——可能是完全沒登入，
 * 也可能是 gh 版本改了輸出格式；兩者都應該讓呼叫端停下來，不是憑猜測繼續。
 *
 * @param {string} statusOutput
 * @returns {string | null}
 */
export function parseActiveGhAccount(statusOutput) {
  let candidate = null;

  for (const line of statusOutput.split("\n")) {
    const accountMatch = line.match(/Logged in to \S+ account (\S+)/);

    if (accountMatch) {
      candidate = accountMatch[1];
      continue;
    }

    const activeMatch = line.match(/Active account:\s*(true|false)/);

    if (activeMatch && candidate && activeMatch[1] === "true") {
      return candidate;
    }
  }

  return null;
}

/**
 * 解析 GitHub remote URL，取出帳號與 repo 名稱。
 *
 * 支援 `git remote get-url origin`可能回傳的三種常見形式：
 * `https://github.com/<owner>/<repo>.git`、`git@github.com:<owner>/<repo>.git`、
 * `ssh://git@github.com/<owner>/<repo>.git`。解析不出來（非 GitHub、格式不符）
 * 回傳 null，呼叫端一律把 null 當成「沒有可用的 remote 資訊」處理，不猜測。
 *
 * @param {string | null | undefined} url
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGithubRemoteUrl(url) {
  if (typeof url !== "string") {
    return null;
  }

  const trimmed = url.trim();

  if (trimmed === "") {
    return null;
  }

  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);

    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  return null;
}

/**
 * 判斷這次執行要 create／push／confirm-link／stop，以及為什麼。
 *
 * 純函式，不碰檔案系統或網路——所有輸入都是呼叫端先查好的事實，這樣才能
 * 不需要真正呼叫 gh／git 就把每一種分支都測到。
 *
 * 四種結果：
 *   - `create`：本機沒有 remote，GitHub 上也沒有同名 repo → 第一次上線。
 *   - `push`：本機 remote 已指向 `expectedAccount/slug` → 直接推送更新。
 *   - `confirm-link`：本機沒有 remote，但 GitHub 上已經有 `expectedAccount/slug`。
 *     單從名稱無法判斷這是本專案先前建立的，還是恰好撞名——交給呼叫端問使用者。
 *   - `stop`：remote 指向別的帳號，或指向的 repo 名稱跟這個專案的 slug 不一致。
 *     只回報，不自動修正——remote 指向舊帳號是實際發生過的情況
 *     （`teacher-dashboard` 至今仍指向 `gpge0805`）。
 *
 * @param {{
 *   remote: { owner: string, repo: string } | null,
 *   expectedAccount: string,
 *   remoteRepoExists: boolean,
 *   slug: string,
 * }} input
 * @returns {{ type: "create" | "push" | "confirm-link" | "stop", reason: string }}
 */
export function decideRepoAction({ remote, expectedAccount, remoteRepoExists, slug }) {
  if (remote === null) {
    if (!remoteRepoExists) {
      return {
        type: "create",
        reason: `尚未建立 repo，將建立 ${expectedAccount}/${slug}（private）。`,
      };
    }

    return {
      type: "confirm-link",
      reason:
        `GitHub 上已經有 ${expectedAccount}/${slug}，但本機這個資料夾還沒設定 remote。` +
        "無法只從名稱判斷這是同一個專案的第二次，還是恰好撞名——需要你確認。",
    };
  }

  if (remote.owner !== expectedAccount) {
    return {
      type: "stop",
      reason:
        `本機 remote 指向 ${remote.owner}/${remote.repo}，但目前作用中的帳號是 ${expectedAccount}。` +
        "remote 指向舊帳號是實際發生過的情況，必須先確認再繼續，不會自動改。",
    };
  }

  if (remote.repo !== slug) {
    return {
      type: "stop",
      reason:
        `本機 remote 指向 ${remote.owner}/${remote.repo}，與這個專案的代稱 ${slug} 不一致。` +
        `project-hub.json 的 slug 打錯，或 remote 設定本身有誤，請先確認。`,
    };
  }

  return {
    type: "push",
    reason: `remote 已指向 ${expectedAccount}/${slug}，將直接推送更新。`,
  };
}

/**
 * @typedef {{ step: string, status: "ok" | "skipped" | "stopped", detail: string }} PublishStep
 * @typedef {{ ok: boolean, steps: PublishStep[], repoUrl?: string }} PublishResult
 */

/**
 * 把一個專案發佈到 GitHub（含建立 repo／推送更新，一律 private）。
 *
 * 依 `2026-08-24-工作計畫.md` 階段 B 規格的 10 個步驟實作。使用者實際要
 * 動手的只有三處：確認目標資料夾、確認作用中帳號、確認需你確認的檔案清單
 * （以及撞名時的第四處：確認是否接上既有 repo）。
 *
 * `options.confirm` 是唯一的互動點，測試時可以注入假的（永遠回 true/false），
 * 讓每一條分支都能在不碰真實 gh／git 的情況下測到。`options.runCommand`
 * 同理，預設是真正執行外部指令的 `run()`。
 *
 * @param {string} dir
 * @param {{
 *   confirm: (message: string) => Promise<boolean>,
 *   runCommand?: typeof run,
 *   runBuild?: boolean,
 *   runTests?: boolean,
 *   runTypecheck?: boolean,
 * }} options
 * @returns {Promise<PublishResult>}
 */
export async function publishToGithub(dir, options) {
  const runCommand = options.runCommand ?? run;
  /** @type {PublishStep[]} */
  const steps = [];

  /**
   * @param {string} step
   * @param {string} detail
   * @returns {PublishResult}
   */
  function stop(step, detail) {
    steps.push({ step, status: "stopped", detail });
    return { ok: false, steps };
  }

  // ── 步驟 0：讀 manifest，確認目標資料夾 ──────────────────────────
  let manifestText;

  try {
    manifestText = readFileSync(join(dir, MANIFEST_FILENAME), "utf8");
  } catch {
    return stop("read-manifest", `讀不到 ${MANIFEST_FILENAME}，無法判斷這個專案的名稱與代稱。`);
  }

  const manifest = parseManifest(manifestText);

  if (!manifest.ok) {
    return stop("read-manifest", `${MANIFEST_FILENAME} 內容有問題，請先跑 hub manifest 檢查。`);
  }

  const { name, slug } = manifest.value;

  steps.push({ step: "read-manifest", status: "ok", detail: `名稱：${name}　代稱：${slug}` });

  const confirmedTarget = await options.confirm(
    `即將處理專案「${name}」（代稱 ${slug}）\n位於：${dir}\n確定是這個資料夾嗎？`,
  );

  if (!confirmedTarget) {
    return stop("confirm-target", "使用者未確認目標資料夾，中止。");
  }

  steps.push({ step: "confirm-target", status: "ok", detail: "已確認目標資料夾。" });

  // ── 步驟 1：檢查 gh 是否安裝 ──────────────────────────────────────
  const versionResult = await runCommand("gh", ["--version"], dir);

  if (versionResult.code !== 0) {
    return stop(
      "gh-installed",
      "找不到 gh（GitHub CLI）。請先安裝：winget install --id GitHub.cli，安裝後重新開一個終端機再試一次。",
    );
  }

  steps.push({ step: "gh-installed", status: "ok", detail: "gh 已安裝。" });

  // ── 步驟 2：檢查登入狀態，並要求確認作用中帳號 ──────────────────
  const authResult = await runCommand("gh", ["auth", "status"], dir);
  const activeAccount = parseActiveGhAccount(`${authResult.stdout}\n${authResult.stderr}`);

  if (!activeAccount) {
    return stop("gh-logged-in", "沒有偵測到已登入的 GitHub 帳號。請先執行：gh auth login");
  }

  const confirmedAccount = await options.confirm(
    `目前作用中的 GitHub 帳號是「${activeAccount}」，即將用這個帳號操作 GitHub。\n` +
      "如果這不是你要的帳號，請先 Ctrl+C 中止，執行 gh auth switch 換好帳號後再重新執行本指令。",
  );

  if (!confirmedAccount) {
    return stop("confirm-account", "使用者未確認作用中帳號，中止。");
  }

  steps.push({ step: "confirm-account", status: "ok", detail: `作用中帳號：${activeAccount}` });

  // ── 步驟 3＋4：判斷 create／push／confirm-link／stop ─────────────
  const hasLocalGit = existsSync(join(dir, ".git"));
  /** @type {{ owner: string, repo: string } | null} */
  let remote = null;

  if (hasLocalGit) {
    const remoteResult = await runCommand("git", ["remote", "get-url", "origin"], dir);

    if (remoteResult.code === 0) {
      remote = parseGithubRemoteUrl(remoteResult.stdout.trim());
    }
  }

  let remoteRepoExists = false;

  if (remote === null) {
    const viewResult = await runCommand("gh", ["repo", "view", `${activeAccount}/${slug}`], dir);

    remoteRepoExists = viewResult.code === 0;
  }

  const decision = decideRepoAction({ remote, expectedAccount: activeAccount, remoteRepoExists, slug });

  if (decision.type === "stop") {
    return stop("decide-action", decision.reason);
  }

  if (decision.type === "confirm-link") {
    const confirmedLink = await options.confirm(
      `${decision.reason}\n\n如果確定這是同一個專案，會把本機接上那個 repo 並推送更新。` +
        "如果不確定，請先自行到 GitHub 檢查後再重新執行本指令。",
    );

    if (!confirmedLink) {
      return stop("decide-action", "使用者選擇不接上既有 repo，需先自行確認後再重新執行。");
    }
  }

  steps.push({ step: "decide-action", status: "ok", detail: decision.reason });

  // ── 步驟 5＋6：雙出口掃描，需確認級項目等使用者同意 ──────────────
  // 只做推送不做部署，所以刻意跳過建置／測試／型別檢查——那些是「能不能上線」
  // 的問題，這裡只在乎「這批檔案能不能安全推到 GitHub」。掃描本身
  // （版控範圍比對、憑證與金鑰偵測）不受這幾個旗標影響，一定會執行。
  const checkResult = await runPreDeployChecks(dir, {
    runBuild: options.runBuild ?? false,
    runTests: options.runTests ?? false,
    runTypecheck: options.runTypecheck ?? false,
  });

  if (checkResult.blocked) {
    steps.push({ step: "scan", status: "stopped", detail: renderChecks(checkResult) });

    return { ok: false, steps };
  }

  steps.push({ step: "scan", status: "ok", detail: renderChecks(checkResult) });

  if (checkResult.needsConfirmation) {
    const confirmedFiles = await options.confirm(
      "掃描發現需要你確認的檔案（見上方報告）。確定要照這份清單推送嗎？",
    );

    if (!confirmedFiles) {
      return stop("confirm-files", "使用者未確認需確認的檔案，中止推送。");
    }

    steps.push({ step: "confirm-files", status: "ok", detail: "已確認需確認的檔案清單。" });
  } else {
    steps.push({ step: "confirm-files", status: "skipped", detail: "掃描沒有需確認的項目。" });
  }

  // ── 步驟 7：必要時 init＋commit（只動本機） ──────────────────────
  if (!hasLocalGit) {
    const initResult = await runCommand("git", ["init"], dir);

    if (initResult.code !== 0) {
      return stop("git-init", `git init 失敗：${initResult.stderr || initResult.stdout}`);
    }

    steps.push({ step: "git-init", status: "ok", detail: "已初始化本機 git repo。" });
  } else {
    steps.push({ step: "git-init", status: "skipped", detail: "已經是 git repo。" });
  }

  const addResult = await runCommand("git", ["add", "-A"], dir);

  if (addResult.code !== 0) {
    return stop("git-add", `git add 失敗：${addResult.stderr || addResult.stdout}`);
  }

  const statusResult = await runCommand("git", ["status", "--porcelain"], dir);
  const hasChanges = statusResult.stdout.trim() !== "";

  if (hasChanges) {
    const commitResult = await runCommand("git", ["commit", "-m", `Publish ${name} via hub github`], dir);

    if (commitResult.code !== 0) {
      return stop("git-commit", `git commit 失敗：${commitResult.stderr || commitResult.stdout}`);
    }

    steps.push({ step: "git-commit", status: "ok", detail: "已建立 commit。" });
  } else {
    steps.push({ step: "git-commit", status: "skipped", detail: "沒有變更需要 commit。" });
  }

  // ── 步驟 8：建立 repo 或推送（唯一不可逆的外部動作） ─────────────
  if (decision.type === "create") {
    const createResult = await runCommand(
      "gh",
      ["repo", "create", `${activeAccount}/${slug}`, "--private", "--source", dir, "--remote", "origin", "--push"],
      dir,
    );

    if (createResult.code !== 0) {
      return stop("publish", `建立 repo 失敗：${createResult.stderr || createResult.stdout}`);
    }

    steps.push({ step: "publish", status: "ok", detail: `已建立 private repo ${activeAccount}/${slug} 並推送。` });
  } else if (decision.type === "confirm-link") {
    const remoteUrl = `https://github.com/${activeAccount}/${slug}.git`;
    const addRemoteResult = await runCommand("git", ["remote", "add", "origin", remoteUrl], dir);

    if (addRemoteResult.code !== 0) {
      return stop("publish", `設定 remote 失敗：${addRemoteResult.stderr || addRemoteResult.stdout}`);
    }

    const pushResult = await runCommand("git", ["push", "-u", "origin", "HEAD"], dir);

    if (pushResult.code !== 0) {
      return stop("publish", `推送失敗：${pushResult.stderr || pushResult.stdout}`);
    }

    steps.push({ step: "publish", status: "ok", detail: `已接上並推送到 ${activeAccount}/${slug}。` });
  } else {
    const pushResult = await runCommand("git", ["push"], dir);

    if (pushResult.code !== 0) {
      return stop("publish", `推送失敗：${pushResult.stderr || pushResult.stdout}`);
    }

    steps.push({ step: "publish", status: "ok", detail: `已推送更新到 ${activeAccount}/${slug}。` });
  }

  // ── 步驟 9：線上驗證，逐項回報而不是只說「完成」 ────────────────
  const viewAfter = await runCommand(
    "gh",
    ["repo", "view", `${activeAccount}/${slug}`, "--json", "visibility,name"],
    dir,
  );

  if (viewAfter.code !== 0) {
    steps.push({
      step: "verify",
      status: "stopped",
      detail: `已推送完成，但無法連線確認線上狀態：${viewAfter.stderr || viewAfter.stdout}`,
    });

    return { ok: false, steps };
  }

  let visibility = "unknown";

  try {
    visibility = JSON.parse(viewAfter.stdout).visibility ?? "unknown";
  } catch {
    // 保持 unknown。已經推送成功了，JSON 解析失敗不該讓整個流程回報失敗，
    // 但也不能假裝驗證通過——下面用 isPrivate 判斷會如實回報「不是 private」。
  }

  const isPrivate = String(visibility).toUpperCase() === "PRIVATE";

  steps.push({
    step: "verify",
    status: isPrivate ? "ok" : "stopped",
    detail: isPrivate
      ? `已驗證線上為 private：${activeAccount}/${slug}`
      : `已推送完成，但線上可見性回報為「${visibility}」，預期應為 private。請自行到 GitHub 確認。`,
  });

  return {
    ok: isPrivate,
    steps,
    repoUrl: `https://github.com/${activeAccount}/${slug}`,
  };
}
