import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashPassword } from "../src/access-gate/password.js";
import {
  deriveDatabaseName,
  deriveWorkerName,
  EXAMPLE_PROJECT_SOURCE,
  EXAMPLE_PROJECT_TARGET,
  initHub,
  patchWranglerConfig,
} from "../tools/init.mjs";

const ALWAYS_YES = async () => true;
const NO_INTERACTIVE_PROMPT = async () => {
  throw new Error("互動模式的 prompt() 在這個測試裡不該被呼叫——測試用 --yes 帶旗標。");
};

/**
 * 建一份跟真正 wrangler.jsonc 同樣形狀（含註解、含 vars.ADMIN_ENABLED、
 * 含 d1_databases）的丟棄式副本，供 `initHub()` 與 `patchWranglerConfig()`
 * 操作。刻意保留跟正式檔案一樣的註解密度，確保修補函式在真實情境下
 * 也不會誤中說明文字。
 *
 * @param {{ databaseId?: string, adminEnabled?: string }} [options]
 * @returns {string} 丟棄式副本的資料夾路徑
 */
function makeHubRoot(options = {}) {
  const databaseId = options.databaseId ?? "00000000-0000-0000-0000-000000000010";
  const adminEnabled = options.adminEnabled ?? "false";
  const dir = mkdtempSync(join(tmpdir(), "hub-init-"));

  writeFileSync(
    join(dir, "wrangler.jsonc"),
    `{
	"$schema": "./node_modules/wrangler/config-schema.json",
	"name": "test-hub",
	"main": "src/index.js",
	"compatibility_date": "2026-08-08",
	// 管理介面的總開關，預設關閉。
	// 本機開發透過 .dev.vars 設為 "true"（該檔案不會被部署，也不進版本控制）。
	// 例如註解裡也可能提到 "database_id": "00000000-0000-0000-0000-000000000099"
	// 這種假造的說明文字——修補函式必須不會被這裡騙到。
	"vars": {
		"ADMIN_ENABLED": "${adminEnabled}"
	},
	"assets": {
		"directory": "./public/",
		"binding": "ASSETS",
		"run_worker_first": [
			"/api/*",
			"/media/*",
			"/admin/*"
		]
	},
	// D1 資料庫。這一段的佔位值等 hub init 執行時會被換成真的 database_id。
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "test-hub-db",
			"database_id": "${databaseId}",
			"migrations_dir": "migrations"
		}
	]
}
`,
  );

  return dir;
}

/**
 * @param {{ existingDatabases?: Record<string, any>[], deployedUrl?: string, deployShouldFail?: boolean }} [options]
 * @returns {{ run: (command: string, args: string[], cwd?: string) => Promise<any>, calls: any[][] }}
 */
function createFakeRunner(options = {}) {
  const databases = [...(options.existingDatabases ?? [])];
  const deployedUrl = options.deployedUrl ?? "https://test-hub.example.workers.dev";
  const calls = [];
  /** 部署呼叫時的 --secrets-file 內容，趁暫存目錄還沒被 deployWithSecrets()
   *  的 finally 區塊刪除前同步讀出——測試跑完（initHub() 已經 resolve）
   *  再讀就晚了，與 test/hub-ship.test.mjs 的 captureSecretsFile() 同一個理由。 */
  const capturedSecrets = { content: null };

  return {
    calls,
    capturedSecrets,
    async run(command, args, cwd) {
      calls.push([command, ...args]);

      if (command === "gh" && args[0] === "--version") {
        return { code: 0, stdout: "gh version 2.0.0\n", stderr: "" };
      }

      if (command === "gh" && args[0] === "auth" && args[1] === "status") {
        return {
          code: 0,
          stdout: "github.com\n  ✓ Logged in to github.com account testuser (keyring)\n  - Active account: true\n",
          stderr: "",
        };
      }

      // 以下都是模擬 wrangler 呼叫：command 固定是 process.execPath——
      // 這是 EFTYPE 坑的守門斷言（見下方個別測試），args[0] 是
      // wrangler.js 的路徑，args[1] 開始才是真正的子指令。
      const sub = args.slice(1);

      if (sub[0] === "whoami") {
        return { code: 0, stdout: "👋 You are logged in with an OAuth Token, associated with the email test@example.com.\n", stderr: "" };
      }

      if (sub[0] === "d1" && sub[1] === "list" && sub[2] === "--json") {
        return { code: 0, stdout: JSON.stringify(databases), stderr: "" };
      }

      if (sub[0] === "d1" && sub[1] === "create") {
        const name = sub[2];
        const uuid = `uuid-${name}`;

        databases.push({ name, uuid, created_at: "2026-08-28T00:00:00Z", file_size: 0, jurisdiction: "", num_tables: 0, version: "1" });

        return { code: 0, stdout: `✅ Successfully created DB '${name}'\n`, stderr: "" };
      }

      if (sub[0] === "d1" && sub[1] === "migrations" && sub[2] === "apply") {
        return { code: 0, stdout: "Migrations applied.\n", stderr: "" };
      }

      if (sub[0] === "deploy") {
        const secretsFileIndex = args.indexOf("--secrets-file");

        if (secretsFileIndex !== -1) {
          capturedSecrets.content = readFileSync(args[secretsFileIndex + 1], "utf8");
        }

        if (options.deployShouldFail) {
          return { code: 1, stdout: "", stderr: "deploy failed (simulated)" };
        }

        return { code: 0, stdout: `Uploaded test-hub (1.0 sec)
  ${deployedUrl}
`, stderr: "" };
      }

      if (sub[0] === "d1" && sub[1] === "execute") {
        return { code: 0, stdout: JSON.stringify([{ success: true, results: [] }]), stderr: "" };
      }

      throw new Error(`fake runner 沒有處理這個呼叫：${command} ${args.join(" ")}`);
    },
  };
}

let testPasswordHash;

test.before(async () => {
  testPasswordHash = await hashPassword("test-password-do-not-use");
});

// ── deriveDatabaseName：純函式 ──

test("deriveDatabaseName keeps ASCII characters and appends -hub-db", () => {
  assert.equal(deriveDatabaseName("Li Teacher Hub"), "li-teacher-hub-hub-db");
});

test("deriveDatabaseName falls back to a stable hash suffix when the name has no ASCII characters", () => {
  const name = deriveDatabaseName("李老師的展示中心");

  assert.match(name, /^hub-db-[0-9a-f]{6}$/);
  // 穩定：同一個站名兩次呼叫要算出同一個名稱，這是安全重跑機制的前提。
  assert.equal(name, deriveDatabaseName("李老師的展示中心"));
});

test("deriveDatabaseName produces different names for different all-Chinese site names", () => {
  assert.notEqual(deriveDatabaseName("李老師的展示中心"), deriveDatabaseName("王老師的展示中心"));
});

// ── deriveWorkerName：純函式 ──
//
// 存在理由：範本的 wrangler.jsonc 寫死 "ai-project-hub"，不改名的話每個人
// 部署出去的 Worker 都同名，帳號裡已有同名 Worker 就會被覆蓋且毫無警告。

test("deriveWorkerName keeps ASCII characters and appends -hub", () => {
  assert.equal(deriveWorkerName("Li Teacher Hub"), "li-teacher-hub-hub");
});

test("deriveWorkerName falls back to a stable hash suffix when the name has no ASCII characters", () => {
  const name = deriveWorkerName("李老師的展示中心");

  assert.match(name, /^hub-[0-9a-f]{6}$/);
  // 穩定性的理由同 deriveDatabaseName：重跑要算出同一個名字。
  assert.equal(name, deriveWorkerName("李老師的展示中心"));
});

test("deriveWorkerName never collides with the database name for the same site", () => {
  for (const siteName of ["Li Teacher Hub", "李老師的展示中心"]) {
    assert.notEqual(deriveWorkerName(siteName), deriveDatabaseName(siteName));
  }
});

// ── patchWranglerConfig：JSONC 修補 ──

test("patchWranglerConfig changes only the two DB lines, keeps every comment and the rest of the file untouched", () => {
  const dir = makeHubRoot();
  const wranglerPath = join(dir, "wrangler.jsonc");
  const before = readFileSync(wranglerPath, "utf8");

  patchWranglerConfig(wranglerPath, { databaseId: "11111111-2222-3333-4444-555555555555", databaseName: "renamed-db" });

  const after = readFileSync(wranglerPath, "utf8");

  assert.notEqual(after, before);
  assert.ok(after.includes('"database_id": "11111111-2222-3333-4444-555555555555"'));
  assert.ok(!after.includes("00000000-0000-0000-0000-000000000010"));

  // 只有 database_id 與 database_name 那兩行改變（2026-08-28 起 name 也要換，
  // 理由見 tools/init.mjs 的 patchWranglerConfig 檔頭），其餘每一行（含註解、
  // 含註解裡假造的說明文字）逐字保留。
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  assert.equal(beforeLines.length, afterLines.length);

  const changedLines = beforeLines
    .map((line, index) => (line !== afterLines[index] ? index : -1))
    .filter((index) => index !== -1);

  assert.deepEqual(changedLines.map((index) => beforeLines[index].trim()).sort(), [
    '"database_id": "00000000-0000-0000-0000-000000000010",',
    '"database_name": "test-hub-db",',
  ].sort());

  // 註解裡假造的 database_id 說明文字必須原封不動，不能被誤觸。
  assert.ok(after.includes('"database_id": "00000000-0000-0000-0000-000000000099"'));
});

// 2026-08-28 真實端到端測試踩到的 bug 的守門測試。
//
// 只換 database_id 而不換 database_name，migration 會失敗——因為
// `wrangler d1 migrations apply <名稱>` 是拿那個名稱去 wrangler.jsonc 的
// database_name 欄位查，不是直接對 API 查。而它的錯誤訊息
// （「Couldn't find a D1 DB with the name or binding '<名稱>'」）完全沒有
// 指出「你的設定檔名稱沒換」，光看訊息很難找到成因。
test("patchWranglerConfig also replaces database_name — migrations look the DB up by name in the config", () => {
  const dir = makeHubRoot();
  const wranglerPath = join(dir, "wrangler.jsonc");

  patchWranglerConfig(wranglerPath, {
    databaseId: "11111111-2222-3333-4444-555555555555",
    databaseName: "my-new-hub-db",
  });

  const patched = readFileSync(wranglerPath, "utf8");

  assert.ok(patched.includes('"database_name": "my-new-hub-db"'), "database_name 必須換成新名稱");
  assert.ok(patched.includes('"database_id": "11111111-2222-3333-4444-555555555555"'));
  assert.ok(!patched.includes('"database_name": "test-hub-db"'), "舊的資料庫名稱不該留在檔案裡");
});

test("patchWranglerConfig also replaces ADMIN_ENABLED when adminEnabled is provided", () => {
  const dir = makeHubRoot({ adminEnabled: "false" });
  const wranglerPath = join(dir, "wrangler.jsonc");

  patchWranglerConfig(wranglerPath, { databaseId: "11111111-2222-3333-4444-555555555555", databaseName: "renamed-db", adminEnabled: true });

  const after = readFileSync(wranglerPath, "utf8");

  assert.ok(after.includes('"ADMIN_ENABLED": "true"'));
});

test("patchWranglerConfig replaces the top-level worker name without touching database_name", () => {
  const dir = makeHubRoot();
  const wranglerPath = join(dir, "wrangler.jsonc");

  patchWranglerConfig(wranglerPath, {
    databaseId: "11111111-2222-3333-4444-555555555555",
    databaseName: "renamed-db",
    workerName: "li-teacher-hub-hub",
  });

  const after = readFileSync(wranglerPath, "utf8");

  assert.ok(after.includes('"name": "li-teacher-hub-hub"'), "頂層 name 要換成新值");
  assert.ok(!after.includes('"name": "test-hub"'), "舊的 worker 名稱不該還在");

  /*
   * 這一條才是重點：`replaceQuotedValue` 用的 pattern 是 `"name"\s*:\s*"…"`，
   * 而檔案裡還有 `"database_name"`。如果哪天有人把 pattern 放寬成不要求
   * 前面那個引號，這裡就會誤把 database_name 改掉——那個錯誤不會有任何
   * 錯誤訊息，只會讓 migration 找不到資料庫。
   */
  assert.ok(after.includes('"database_name": "renamed-db"'), "database_name 要維持由自己的規則決定");
});

test("patchWranglerConfig leaves the worker name alone when workerName is not given", () => {
  const dir = makeHubRoot();
  const wranglerPath = join(dir, "wrangler.jsonc");

  patchWranglerConfig(wranglerPath, {
    databaseId: "11111111-2222-3333-4444-555555555555",
    databaseName: "renamed-db",
  });

  assert.ok(readFileSync(wranglerPath, "utf8").includes('"name": "test-hub"'));
});

test("patchWranglerConfig throws and does not write anything when database_id is missing from the parsed config", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-init-broken-"));
  const wranglerPath = join(dir, "wrangler.jsonc");
  const original = `{\n\t"name": "broken",\n\t"d1_databases": []\n}\n`;

  writeFileSync(wranglerPath, original);

  assert.throws(() => patchWranglerConfig(wranglerPath, { databaseId: "x", databaseName: "y" }));
  assert.equal(readFileSync(wranglerPath, "utf8"), original);
});

// ── initHub：全流程整合，全部透過假的注入點 ──

/**
 * @param {object} [overrides]
 */
function baseFlags(overrides = {}) {
  return {
    siteName: "測試老師的展示中心",
    passwordHash: testPasswordHash,
    layout: "grid",
    admin: "true",
    ...overrides,
  };
}

test("database_id already a real value is rejected before touching anything else", async () => {
  const dir = makeHubRoot({ databaseId: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d" });
  const runner = createFakeRunner();

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "already-initialized");
  assert.equal(runner.calls.length, 0, "拒絕應該發生在任何外部指令之前");
});

test("wrangler not logged in stops before the four questions are asked", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner();
  const originalRun = runner.run;

  runner.run = async (command, args, cwd) => {
    const sub = args.slice(1);

    if (sub[0] === "whoami") {
      runner.calls.push([command, ...args]);
      return { code: 0, stdout: "You are not authenticated. Please run `wrangler login`.\n", stderr: "" };
    }

    return originalRun(command, args, cwd);
  };

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "wrangler-logged-in");
  assert.ok(!result.steps.some((step) => step.step === "collect-answers"), "不該問到四個問題");
});

// 2026-08-28 行為刻意變更：gh 未登入從「阻擋」改為「提醒」。
//
// 理由：`hub init` 從頭到尾完全不碰 GitHub（只建資料庫、套 migration、部署展示
// 中心），為一個與本指令無關的工具擋住「建立自己的展示中心」對新手是沒有理由的
// 挫折。但完全不檢查也不對——他下一步幾乎一定是 `hub ship`，那時才發現要裝 gh
// 反而更難理解。所以照樣檢查、照樣說清楚下一步，但不中止流程。
//
// 注意 `hub github` 的同類檢查**仍然是阻擋**（見 test/hub-github.test.mjs），
// 那是對的：那個指令真的需要 GitHub。兩者的差別不是不一致，是各自需要什麼。
test("gh not logged in warns but does not stop — hub init never touches GitHub", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner();
  const originalRun = runner.run;

  runner.run = async (command, args, cwd) => {
    if (command === "gh" && args[0] === "auth" && args[1] === "status") {
      runner.calls.push([command, ...args]);
      return { code: 0, stdout: "You are not logged into any GitHub hosts.\n", stderr: "" };
    }

    return originalRun(command, args, cwd);
  };

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  const ghStep = result.steps.find((step) => step.step === "gh-ready");

  assert.ok(ghStep, "應該有一個 gh-ready 步驟");
  assert.equal(ghStep.status, "skipped", "未登入時是提醒（skipped），不是阻擋（stopped）");
  assert.match(ghStep.detail, /gh auth login/, "提醒必須告訴使用者之後要執行什麼");
  assert.ok(
    !result.steps.some((step) => step.status === "stopped" && step.step === "gh-ready"),
    "gh 未登入不該讓流程停止",
  );
  assert.ok(
    result.steps.some((step) => step.step === "collect-answers"),
    "流程應該繼續走到四個問題，證明 gh 未登入沒有擋住 hub init",
  );
});

test("--yes without --site-name stops with an explicit error, not a silent default", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner();

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags({ siteName: undefined }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "collect-answers");
  assert.match(result.steps.at(-1).detail, /--site-name/);
  assert.ok(!result.steps.some((step) => step.step === "create-database"));
});

test("--yes without --password-hash stops with an explicit error, not a silent default", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner();

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags({ passwordHash: undefined }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "collect-answers");
  assert.match(result.steps.at(-1).detail, /--password-hash/);
});

test("--yes without --layout or --admin falls back to the documented defaults (grid / open), does not stop", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner();

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags({ layout: undefined, admin: undefined }),
  });

  assert.equal(result.ok, true);

  const wranglerPath = join(dir, "wrangler.jsonc");
  const after = readFileSync(wranglerPath, "utf8");

  assert.ok(after.includes('"ADMIN_ENABLED": "true"'), "後台預設應該是開");

  const executeCall = runner.calls.find((call) => call.includes("execute"));
  assert.ok(executeCall.some((arg) => typeof arg === "string" && arg.includes("'gallery_layout'") && arg.includes("'grid'")));
});

test("a full run creates the database, patches wrangler.jsonc, deploys with both secrets, and writes site_settings", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner({ deployedUrl: "https://test-hub-full.example.workers.dev" });

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.deploymentUrl, "https://test-hub-full.example.workers.dev");

  // deploy 的 command 必須是 process.execPath——EFTYPE 坑的守門斷言
  // （2026-08-26 真部署測試踩到：wrangler.js 的路徑不能直接當 command）。
  const deployCall = runner.calls.find((call) => call.includes("deploy"));
  assert.equal(deployCall[0], process.execPath);

  assert.ok(deployCall.includes("--secrets-file"), "應該帶 --secrets-file");

  const secretsContent = runner.capturedSecrets.content;
  assert.ok(secretsContent, "fake runner 應該在 deploy 時同步讀到 --secrets-file 的內容");
  assert.match(secretsContent, /^ADMIN_PASSWORD_HASH=/m);
  assert.match(secretsContent, /^SESSION_SIGNING_KEY=[0-9a-f]{64}$/m);

  // 站名全是中文、沒有 ASCII 字元，deriveDatabaseName() 會回退成
  // hub-db-<6 碼隨機十六進位>，fake runner 建立的 uuid 是 `uuid-${name}`。
  const wranglerAfter = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  assert.match(wranglerAfter, /"database_id": "uuid-hub-db-[0-9a-f]{6}"/);

  /*
   * Worker 名稱必須被換掉——這條是「以後有人把 patchWranglerConfig 的
   * workerName 參數拿掉」的守門員。範本寫死的名字若跟著部署出去，
   * 帳號裡有同名 Worker 就會被覆蓋，而且不會有任何警告。
   */
  assert.match(wranglerAfter, /"name": "hub-[0-9a-f]{6}"/, "頂層 name 應該換成由站名推導的 Worker 名稱");
  assert.ok(!wranglerAfter.includes('"name": "test-hub"'), "範本寫死的 Worker 名稱不該留下");

  const confirmStep = result.steps.find((step) => step.step === "write-config");
  assert.match(confirmStep.detail, /Worker 名稱/, "回報訊息要說出改了 Worker 名稱");

  const executeCall = runner.calls.find((call) => call.includes("execute"));
  assert.ok(executeCall.some((arg) => typeof arg === "string" && arg.includes("site_name") && arg.includes("測試老師的展示中心")));

  assert.equal(result.steps.at(-1).step, "next-steps");
  assert.match(result.steps.at(-1).detail, /站台設定/);
  assert.match(result.steps.at(-1).detail, /hash-admin-password\.mjs/);
});

test("re-running against an existing same-name database reuses it instead of creating a duplicate", async () => {
  const dir = makeHubRoot();
  const databaseName = deriveDatabaseName("測試老師的展示中心");
  const runner = createFakeRunner({
    existingDatabases: [
      { name: databaseName, uuid: "already-exists-uuid", created_at: "", file_size: 0, jurisdiction: "", num_tables: 0, version: "1" },
    ],
  });

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  assert.equal(result.ok, true);

  const createCalls = runner.calls.filter((call) => call.includes("create"));
  assert.equal(createCalls.length, 0, "同名資料庫已存在時不應該再呼叫 d1 create");

  const wranglerAfter = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  assert.ok(wranglerAfter.includes('"database_id": "already-exists-uuid"'));
});

test("declining the confirmation stops before any irreversible action, and no database is created", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner();

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: async () => false,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "confirm-plan");
  assert.ok(!runner.calls.some((call) => call.includes("create")));
});

test("a deploy failure reports that the database and migration are already done and it is safe to retry", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner({ deployShouldFail: true });

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "deploy");
  assert.match(result.steps.at(-1).detail, /可以安全重跑/);

  // 資料庫已經建立、wrangler.jsonc 已經被寫入——這是「安全重跑」宣稱成立的依據。
  const wranglerAfter = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  assert.ok(!wranglerAfter.includes("00000000-0000-0000-0000-000000000010"));
});

test("interactive mode (no --yes, no flags) collects answers via the injected prompt", async () => {
  const dir = makeHubRoot();
  const runner = createFakeRunner();

  const answers = ["測試老師的展示中心", testPasswordHash, "", ""];
  const prompt = async () => answers.shift() ?? "";

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt,
    autoApprove: false,
    flags: {},
  });

  assert.equal(result.ok, true);

  const wranglerAfter = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  assert.ok(wranglerAfter.includes('"ADMIN_ENABLED": "true"'), "空白輸入應該套用預設值（開）");
});

/* ==========================================================================
 * 範例專案的複製（2026-08-29 新增，工作計畫階段 4）
 *
 * 為什麼要測這一步：它的失敗方式是**靜默的**。複製沒發生，init 仍然回報成功、
 * 展示中心也真的上線了，使用者只會在稍後跟 AI 說「部署範例專案」時發現
 * 資料夾不存在——而那時他已經離開 init 的輸出、不會聯想到是這一步沒做。
 * ========================================================================== */

/** 在丟棄式的 hub 根目錄裡造出範例專案的權威副本。 */
function makeExampleSource(dir, indexContent = "<!doctype html><title>範例</title>") {
  const source = join(dir, EXAMPLE_PROJECT_SOURCE);
  mkdirSync(join(source, "public"), { recursive: true });
  writeFileSync(join(source, "public", "index.html"), indexContent, "utf8");
  writeFileSync(join(source, "project-hub.json"), JSON.stringify({ name: "連連看遊戲", slug: "link-game" }), "utf8");
  return source;
}

test("hub init 會把範例專案複製到「要部署的專案/」", async () => {
  const dir = makeHubRoot();
  makeExampleSource(dir);
  const runner = createFakeRunner();

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  assert.equal(result.ok, true);

  const copied = join(dir, EXAMPLE_PROJECT_TARGET, "public", "index.html");
  assert.ok(existsSync(copied), "範例專案的 public/index.html 應該被複製過去");

  const step = result.steps.find((one) => one.step === "copy-example");
  assert.ok(step, "應該有 copy-example 這一步");
  assert.equal(step.status, "ok");
});

test("目標資料夾已存在時保留原有內容，不覆寫使用者可能改過的檔案", async () => {
  const dir = makeHubRoot();
  makeExampleSource(dir, "<!doctype html><title>空殼原版</title>");

  // 模擬使用者已經把範例改成自己的內容。
  const target = join(dir, EXAMPLE_PROJECT_TARGET);
  mkdirSync(join(target, "public"), { recursive: true });
  writeFileSync(join(target, "public", "index.html"), "使用者自己改過的內容", "utf8");

  const runner = createFakeRunner();
  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    readFileSync(join(target, "public", "index.html"), "utf8"),
    "使用者自己改過的內容",
    "既有內容被覆寫了——這會直接毀掉使用者的作品",
  );

  const step = result.steps.find((one) => one.step === "copy-example");
  assert.equal(step.status, "skipped");
});

test("找不到範例專案來源時只跳過，不讓整個 hub init 變成失敗", async () => {
  // makeHubRoot() 不會建 templates/，所以來源天然不存在。
  const dir = makeHubRoot();
  const runner = createFakeRunner();

  const result = await initHub({
    rootDir: dir,
    runCommand: runner.run,
    confirm: ALWAYS_YES,
    prompt: NO_INTERACTIVE_PROMPT,
    autoApprove: true,
    flags: baseFlags(),
  });

  // 關鍵斷言：展示中心此時已經部署成功，這一步失敗不該把成功說成失敗，
  // 否則使用者會去重跑 init（那是不必要的、而且會再問一遍所有問題）。
  assert.equal(result.ok, true, "來源不存在不該讓 init 整體失敗");

  const step = result.steps.find((one) => one.step === "copy-example");
  assert.equal(step.status, "skipped");
  assert.match(step.detail, /展示中心本身已經上線/);
});

test("init 的最後說明會告訴使用者：部署完是私人狀態，要到後台改成公開", () => {
  // 這一句是裁決 2 的配套。少了它，使用者部署完會看到空的展示中心、以為失敗。
  const initSource = readFileSync(new URL("../tools/init.mjs", import.meta.url), "utf8");
  assert.match(initSource, /部署範例專案/);
  assert.match(initSource, /改成「公開」/);
});
