/**
 * 五樣工具檢查的測試（2026-08-29）。
 *
 * 這支腳本的失敗方式特別惡劣，所以測試的重點放在「誤判」而不是「跑得動」：
 * 它面對的是一個什麼都還沒裝好的新手，**誤報會直接把人擋在門外**。
 * 誤報「沒裝」→ 他去裝一個已經有的東西，或以為自己做錯了；
 * 誤報「有裝」→ 他往下走，在更深的地方撞到一個沒有線索的錯誤。
 *
 * 2026-08-29 實際踩到的就是前者：Windows 上 `corepack` 是 `.cmd`，
 * `spawn(..., { shell: false })` 執行不了，於是一個運作正常的環境被判成
 * 「pnpm 沒裝」。那個 bug 不會拋例外、不會有錯誤訊息，只會安靜地報錯結論。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkTools, formatReport, installHint, resolveCorepackEntry } from "../scripts/check-tools.mjs";

/**
 * 依指令名回應的假 runner。沒列到的指令一律當成「找不到」（code 127），
 * 與真實 `run()` 在指令不存在時的行為一致。
 *
 * @param {Record<string, { code?: number, stdout?: string, stderr?: string }>} table
 */
function createFakeRunner(table) {
  const calls = [];

  return {
    calls,
    async run(command, args) {
      calls.push({ command, args });

      // corepack 是用 `node <corepack.js> pnpm --version` 呼叫的，
      // 所以要看第一個參數而不是 command 本身。
      const key = args?.[0]?.includes?.("corepack") ? "corepack" : command;
      const hit = table[key];

      if (!hit) return { code: 127, stdout: "", stderr: "not found" };

      return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
    },
  };
}

const ALL_PRESENT = {
  corepack: { stdout: "11.21.0\n" },
  git: { stdout: "git version 2.52.0.windows.1\n" },
  gh: { stdout: "gh version 2.96.0 (2026-07-02)\n" },
  winget: { stdout: "v1.29.290\n" },
};

const BASE = { platform: "win32", nodeVersion: "24.15.0", corepackEntry: "C:/fake/corepack.js" };

test("五樣都在時全部通過，而且不留下任何安裝指令", async () => {
  const runner = createFakeRunner(ALL_PRESENT);
  const report = await checkTools({ ...BASE, runCommand: runner.run });

  assert.equal(report.ok, true);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.hints, [], "已經裝好的工具不該出現安裝指令——那只會製造混淆");
});

test("Git 沒裝時被抓出來，並給出對應平台的安裝指令", async () => {
  const runner = createFakeRunner({ ...ALL_PRESENT, git: undefined });
  const report = await checkTools({ ...BASE, runCommand: runner.run });

  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.map((one) => one.key), ["git"]);
  assert.equal(report.hints.length, 1);
  assert.match(report.hints[0].command, /winget install --id Git\.Git/);
});

test("gh 沒裝時被抓出來", async () => {
  const runner = createFakeRunner({ ...ALL_PRESENT, gh: undefined });
  const report = await checkTools({ ...BASE, runCommand: runner.run });

  assert.deepEqual(report.missing.map((one) => one.key), ["gh"]);
});

test("pnpm 走的是 corepack，不是 PATH 上的 pnpm", async () => {
  // 本專案的既有事實：pnpm 不在 PATH，corepack 才是正解（AGENTS.md 第 4 節）。
  // 若哪天有人把這裡改成直接查 `pnpm`，這個測試會紅。
  const runner = createFakeRunner(ALL_PRESENT);
  await checkTools({ ...BASE, runCommand: runner.run });

  const pnpmDirect = runner.calls.find((call) => call.command === "pnpm");
  assert.equal(pnpmDirect, undefined, "不該直接執行 pnpm——那會對正常環境誤報沒裝");

  const viaCorepack = runner.calls.find((call) => call.args?.[0] === "C:/fake/corepack.js");
  assert.ok(viaCorepack, "應該透過 corepack 的 JS 進入點查 pnpm");
  assert.deepEqual(viaCorepack.args.slice(1), ["pnpm", "--version"]);
});

test("corepack 呼叫方式必須是「node <corepack.js>」，不是把 corepack 當指令", async () => {
  /*
   * 2026-08-29 實際踩到的 bug 的回歸測試。
   *
   * Windows 上 corepack 是 .cmd 包裝檔，`spawn(..., { shell: false })` 執行不了
   * （Node 20 之後明確擋掉），於是運作正常的環境被判成「pnpm 沒裝」。
   * 與 AGENTS.md 第 4 節的 wrangler EFTYPE 同一族的坑。
   */
  const runner = createFakeRunner(ALL_PRESENT);
  await checkTools({ ...BASE, runCommand: runner.run });

  const corepackAsCommand = runner.calls.find((call) => call.command === "corepack");
  assert.equal(corepackAsCommand, undefined, "corepack 不能當成 spawn 的 command——Windows 上執行不了 .cmd");

  const viaNode = runner.calls.find((call) => call.command === process.execPath);
  assert.ok(viaNode, "應該用 process.execPath 執行 corepack 的 .js");
});

test("找不到 corepack 時回報 pnpm 缺少，而不是整支壞掉", async () => {
  const runner = createFakeRunner(ALL_PRESENT);
  const report = await checkTools({ ...BASE, runCommand: runner.run, corepackEntry: null });

  const pnpm = report.results.find((one) => one.key === "pnpm");
  assert.equal(pnpm.ok, false);
  assert.match(pnpm.detail, /找不到 corepack/);
});

test("沒有 winget 時改給官方下載連結，不給一個跑不動的指令", async () => {
  // 【重要】不能假設 Windows 11 一定有 winget：LTSC／N 版、Store 被停用的
  // 網域機器、剛安裝尚未更新的機器都可能沒有。
  const runner = createFakeRunner({ ...ALL_PRESENT, winget: undefined, git: undefined });
  const report = await checkTools({ ...BASE, runCommand: runner.run });

  assert.equal(report.hasWinget, false);
  assert.match(report.hints[0].command, /沒有 winget/);
  assert.match(report.hints[0].command, /git-scm\.com/);
  assert.doesNotMatch(report.hints[0].command, /winget install/, "沒有 winget 就不該叫人跑 winget install");
});

test("Mac 給的是 brew 指令，不是 winget", async () => {
  const runner = createFakeRunner({ ...ALL_PRESENT, git: undefined });
  const report = await checkTools({ platform: "darwin", nodeVersion: "24.15.0", corepackEntry: "/fake/corepack.js", runCommand: runner.run });

  assert.match(report.hints[0].command, /brew install git/);
  assert.doesNotMatch(report.hints[0].command, /winget/);
});

test("Mac 上不會去查 winget", async () => {
  const runner = createFakeRunner(ALL_PRESENT);
  await checkTools({ platform: "darwin", nodeVersion: "24.15.0", corepackEntry: "/fake/corepack.js", runCommand: runner.run });

  assert.equal(runner.calls.find((call) => call.command === "winget"), undefined);
});

test("Node 版本低於下限時被判為缺少", async () => {
  const runner = createFakeRunner(ALL_PRESENT);
  const report = await checkTools({ ...BASE, nodeVersion: "18.20.0", runCommand: runner.run });

  const node = report.results.find((one) => one.key === "node");
  assert.equal(node.ok, false);
  assert.match(node.detail, /需要 20 以上/);
});

test("報告會告訴 Windows 使用者 UAC 會跳出來、裝完要重開終端機", async () => {
  // 少了這兩句，新手看到 UAC 很可能按「否」，或裝完發現指令還是找不到，
  // 兩種都會讓他以為自己做錯了。
  const runner = createFakeRunner({ ...ALL_PRESENT, git: undefined });
  const report = await checkTools({ ...BASE, runCommand: runner.run });
  const text = formatReport(report);

  assert.match(text, /要允許這個應用程式變更你的裝置嗎/);
  assert.match(text, /關掉重開/);
});

test("報告把 AI 助理工具直接記為已確認，不留一個查不出來的項目", async () => {
  const runner = createFakeRunner(ALL_PRESENT);
  const text = formatReport(await checkTools({ ...BASE, runCommand: runner.run }));

  assert.match(text, /AI 助理工具/);
  assert.match(text, /代表它能執行本機指令/);
});

test("resolveCorepackEntry 找不到時回 null，不丟例外", () => {
  assert.equal(resolveCorepackEntry("Z:/definitely/not/here/node.exe"), null);
});

test("installHint 在未知平台仍給得出可行的做法", () => {
  const tool = { winget: "X.Y", brew: "x", download: "https://example.test/dl" };
  assert.match(installHint(tool, "linux", false), /example\.test\/dl/);
});
