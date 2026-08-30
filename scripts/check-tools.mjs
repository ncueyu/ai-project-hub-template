/**
 * 五樣工具的安裝檢查（2026-08-29 工作計畫「五樣工具安裝」階段 1）。
 *
 * ## 這支跟 `check-environment.mjs` 的分界
 *
 * 兩支各回答一個問題，刻意不合併：
 *
 *   - **這一支**：「五樣工具齊了嗎」——只看使用者機器上的工具，
 *     **完全不碰專案狀態**。所以在 `pnpm install` 還沒跑過的乾淨副本上執行，
 *     一樣不會報失敗。這很重要：它的使用時機正是「什麼都還沒裝好」的那一刻。
 *   - `check-environment.mjs`：「這個專案能跑嗎」——查 `node_modules/wrangler`、
 *     `wrangler.jsonc`、`.dev.vars`、本機 D1、hub 檔案是否齊全，全都預設依賴已安裝。
 *
 * 把兩者混在一支的後果是：新手在流程第一步跑檢查，看到一堆「失敗」，
 * 而那些失敗其實只是「還沒輪到」。那會讓他以為自己做錯了。
 *
 * ## 這支【嚴禁】執行安裝
 *
 * 它只檢查、只印出該下什麼指令。實際安裝由 AI 依 `AGENTS.md` 逐條執行，
 * 並依 `AGENTS.md` 第 3 節取得使用者同意——安裝軟體會跳 UAC、改的是使用者
 * 的機器而不是專案，屬於必須先徵得同意的動作。把「唯讀檢查」與「會改變機器
 * 的動作」放進同一支，就沒有辦法安全地叫使用者「先跑一下看看」。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MIN_NODE_MAJOR } from "../tools/config.mjs";

/**
 * 執行一個指令並取回結果。與 `tools/github.mjs` 的 `run()` 同一種形狀
 * （spawn 失敗時回 code 127 而不是丟例外），測試時可整支替換。
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function run(command, args) {
  return new Promise((resolve) => {
    let child;

    try {
      // shell: false —— 不經過殼層，參數不會被再解析一次。
      child = spawn(command, args, { shell: false });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    // 指令不存在時 Windows 會走 error 事件而不是非零離開碼，兩條路都要接。
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * 找出 corepack 的 JS 進入點。
 *
 * 為什麼不能直接 `spawn("corepack", ...)`：Windows 上 `corepack` 是一個 `.cmd`
 * 包裝檔，而 `spawn` 在 `shell: false` 時無法執行 `.cmd`（Node 20 之後更是為了
 * 安全明確擋掉）。2026-08-29 實測就踩到：`corepack pnpm --version` 在終端機
 * 明明回 11.21.0，但這支腳本卻回報「pnpm 沒裝」——**一個運作正常的環境被誤判**。
 *
 * 這與 `AGENTS.md` 第 4 節記的 wrangler `EFTYPE` 是同一族的坑：Windows 上要執行
 * 一個「其實是 JS」的指令，正確做法是把它的 .js 路徑當成 node 的第一個參數，
 * 而不是把包裝檔當成 spawn 的 command。
 *
 * 兩個候選路徑對應不同平台的 Node 安裝配置（Windows 直接放在 node.exe 旁邊，
 * Linux／Mac 多一層 `lib/`）。都找不到就回 null，由呼叫端據此回報。
 *
 * @returns {string | null}
 */
export function resolveCorepackEntry(execPath = process.execPath) {
  const nodeDir = dirname(execPath);

  const candidates = [
    join(nodeDir, "node_modules", "corepack", "dist", "corepack.js"),
    join(nodeDir, "lib", "node_modules", "corepack", "dist", "corepack.js"),
    join(nodeDir, "..", "lib", "node_modules", "corepack", "dist", "corepack.js"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 各工具在兩個平台的安裝方式。
 *
 * Git 與 GitHub CLI 刻意**不訂最低版本**：查不到本專案適用的最低版本依據，
 * 訂一個就是憑空發明（2026-08-29 使用者裁定）。代價是很舊的版本也會被判為
 * 「已安裝」——真的遇到相容性問題時再回頭補，屆時會有實際依據可寫。
 */
const TOOLS = Object.freeze([
  {
    key: "git",
    name: "Git",
    why: "hub github／hub ship 要用它推送程式碼。Node.js 的安裝檔不含 Git，Windows 必須另外裝。",
    probe: ["git", ["--version"]],
    winget: "Git.Git",
    brew: "git",
    download: "https://git-scm.com/downloads",
  },
  {
    key: "gh",
    name: "GitHub CLI",
    why: "hub github 用它建立 repo、確認目前登入哪個帳號。",
    probe: ["gh", ["--version"]],
    winget: "GitHub.cli",
    brew: "gh",
    download: "https://cli.github.com/",
  },
]);

/** @param {string} text 取第一行、去掉前後空白，作為版本顯示用。 */
function firstLine(text) {
  return String(text ?? "").split(/\r?\n/)[0].trim();
}

/**
 * 檢查 Node.js。不需要外部指令——這支腳本本身就跑在 Node 上，
 * `process.versions.node` 直接就是答案，比再 spawn 一次 `node --version` 可靠
 * （後者查到的可能是 PATH 上的另一個 Node）。
 *
 * @param {string} nodeVersion
 */
function checkNode(nodeVersion) {
  const major = Number(nodeVersion.split(".")[0]);
  const ok = Number.isInteger(major) && major >= MIN_NODE_MAJOR;

  return {
    key: "node",
    name: "Node.js",
    ok,
    detail: ok
      ? `v${nodeVersion}`
      : `目前是 v${nodeVersion}，需要 ${MIN_NODE_MAJOR} 以上。`,
  };
}

/**
 * 檢查 pnpm。查的是 `corepack pnpm`，**不是** `pnpm`——本專案的既有事實是
 * pnpm 沒有裝在 PATH 上，但 Node 內建的 corepack 可以直接用（見 AGENTS.md 第 4 節）。
 * 直接查 `pnpm` 會對一個運作正常的環境誤報「沒裝」。
 *
 * @param {(command: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} runCommand
 */
async function checkPnpm(runCommand, corepackEntry) {
  if (!corepackEntry) {
    return {
      key: "pnpm",
      name: "pnpm",
      ok: false,
      detail: "找不到 corepack。corepack 隨 Node.js 一起安裝，找不到通常代表 Node.js 的安裝不完整。",
    };
  }

  const result = await runCommand(process.execPath, [corepackEntry, "pnpm", "--version"]);
  const ok = result.code === 0;

  return {
    key: "pnpm",
    name: "pnpm",
    ok,
    detail: ok
      ? `${firstLine(result.stdout)}（透過 Node 內建的 corepack，不需要另外安裝）`
      : `corepack 無法執行 pnpm：${firstLine(result.stderr) || `離開碼 ${result.code}`}`,
  };
}

/**
 * 檢查一個外部指令是否存在。
 *
 * @param {(command: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} runCommand
 * @param {typeof TOOLS[number]} tool
 */
async function checkExternal(runCommand, tool) {
  const [command, args] = tool.probe;
  const result = await runCommand(command, args);
  const ok = result.code === 0;

  return {
    key: tool.key,
    name: tool.name,
    ok,
    detail: ok ? firstLine(result.stdout) : "找不到這個指令。",
    why: tool.why,
    tool,
  };
}

/**
 * winget 在不在。
 *
 * 【重要】不要假設「Windows 11 一定有 winget」。它隨「應用程式安裝程式」
 * 一起提供，但 LTSC／N 版、Store 被停用的網域機器、剛安裝尚未更新的機器
 * 都可能沒有（2026-08-29：本專案作者的機器實測有 v1.29.290，但那只證明那一台）。
 * 所以這裡要實際查，查不到就改給官方下載連結。
 *
 * @param {(command: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} runCommand
 */
async function checkWinget(runCommand) {
  const result = await runCommand("winget", ["--version"]);
  return result.code === 0;
}

/**
 * 產生某個缺少的工具該怎麼裝的說明。
 *
 * @param {typeof TOOLS[number]} tool
 * @param {string} platform
 * @param {boolean} hasWinget
 */
export function installHint(tool, platform, hasWinget) {
  if (platform === "win32") {
    return hasWinget
      ? `winget install --id ${tool.winget} -e`
      : `這台電腦沒有 winget，請到官網下載安裝：${tool.download}`;
  }

  if (platform === "darwin") {
    return `brew install ${tool.brew}（沒有 Homebrew 的話先到 https://brew.sh 安裝，或直接下載：${tool.download}）`;
  }

  return `請依你的系統套件管理員安裝，或到官網下載：${tool.download}`;
}

/**
 * 執行全部檢查。回傳結構化結果，不印任何東西——印出交給 CLI 部分，
 * 測試才能直接對結果做斷言而不必解析文字。
 *
 * @param {{
 *   runCommand?: (command: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   platform?: string,
 *   nodeVersion?: string,
 *   corepackEntry?: string | null,
 * }} [options]
 */
export async function checkTools(options = {}) {
  const runCommand = options.runCommand ?? run;
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const corepackEntry = options.corepackEntry !== undefined ? options.corepackEntry : resolveCorepackEntry();

  const hasWinget = platform === "win32" ? await checkWinget(runCommand) : false;

  const results = [checkNode(nodeVersion), await checkPnpm(runCommand, corepackEntry)];

  for (const tool of TOOLS) {
    results.push(await checkExternal(runCommand, tool));
  }

  const missing = results.filter((one) => !one.ok);

  return {
    platform,
    hasWinget,
    results,
    missing,
    ok: missing.length === 0,
    /**
     * 缺少的工具各自該下的指令。已經裝好的不會出現在這裡——
     * 印出一串「你已經有了但這是安裝指令」只會製造混淆。
     */
    hints: missing
      .filter((one) => one.tool)
      .map((one) => ({ name: one.name, command: installHint(one.tool, platform, hasWinget) })),
  };
}

/**
 * 把結果組成給人看的文字。
 *
 * @param {Awaited<ReturnType<typeof checkTools>>} report
 */
export function formatReport(report) {
  const lines = ["工具檢查結果", ""];

  for (const item of report.results) {
    lines.push(`${item.ok ? "[OK]  " : "[缺少]"} ${item.name}：${item.detail}`);
  }

  /*
   * AI agent 工具刻意**不做偵測**。
   *
   * 三種工具（Claude Code／ChatGPT Desktop app／Antigravity）的安裝痕跡各不相同，
   * 偵測不可靠；而且根本沒有必要——**你能看到這段輸出，就代表你的 AI 工具能執行
   * 本機指令**，這一項已經被證明了。留一個查不出來的項目在清單上，只會讓人
   * 以為自己還少裝了什麼。
   */
  lines.push("[OK]   AI 助理工具：你看得到這段輸出，代表它能執行本機指令，這一項已經確認。");

  lines.push("");

  if (report.ok) {
    lines.push("五樣工具都齊了，可以進行下一步。");
    return lines.join("\n");
  }

  lines.push(`有 ${report.missing.length} 樣還沒裝好：`);
  lines.push("");

  for (const item of report.missing) {
    if (item.why) lines.push(`· ${item.name}：${item.why}`);
  }

  if (report.hints.length > 0) {
    lines.push("");
    lines.push("安裝指令：");
    for (const hint of report.hints) {
      lines.push(`  ${hint.name}　${hint.command}`);
    }

    if (report.platform === "win32") {
      lines.push("");
      lines.push("安裝時會跳出「要允許這個應用程式變更你的裝置嗎」，請按「是」——");
      lines.push("每一樣各跳一次。按「否」的話那一樣就不會裝上去。");
    }

    lines.push("");
    lines.push("裝完之後【務必】把終端機關掉重開，新裝的指令才會生效。");
    lines.push("然後再跑一次這個檢查確認。");
  }

  return lines.join("\n");
}

// CLI：只有被直接執行時才跑，被 import 時不動作（測試才 import 得進來）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await checkTools();
  process.stdout.write(`${formatReport(report)}\n`);

  // 缺工具時給非零離開碼，讓呼叫端（AI、腳本）能判斷，不必解析文字。
  process.exitCode = report.ok ? 0 : 1;
}
