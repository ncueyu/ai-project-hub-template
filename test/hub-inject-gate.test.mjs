import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  GATE_DIR_NAME,
  GATE_ENTRY_FILENAME,
  generateSigningKey,
  injectGate,
  isOwnGateAlreadyInjected,
  needsGateInjection,
  renderGateEntry,
} from "../tools/inject-gate.mjs";

test("needsGateInjection matches the existing requiresAccessGate rule exactly", () => {
  assert.equal(needsGateInjection("public"), false);
  assert.equal(needsGateInjection("unlisted"), false);
  assert.equal(needsGateInjection("password"), true);
  assert.equal(needsGateInjection("private"), true);
  assert.equal(needsGateInjection("disabled"), true);
});

test("generateSigningKey produces a long, unique, hex string every time", () => {
  const a = generateSigningKey();
  const b = generateSigningKey();

  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b, "兩個專案不該拿到同一把金鑰");
});

test("renderGateEntry defers env.PROJECT_PASSWORD_HASH to inside fetch(), not module top level", () => {
  const source = renderGateEntry({
    projectId: 1,
    visibility: "password",
    policyVersion: 1,
    projectName: "測試",
  });

  const fetchIndex = source.indexOf("fetch(request, env, ctx)");
  const passwordHashIndex = source.indexOf("env.PROJECT_PASSWORD_HASH");

  assert.ok(fetchIndex > -1, "應該有 fetch 處理函式");
  assert.ok(passwordHashIndex > fetchIndex, "讀取 PROJECT_PASSWORD_HASH 必須在 fetch() 裡面，不能在檔案頂層");
  assert.match(source, /import \{ createProtectedWorker \} from "\.\/access-gate\/protected-worker\.js"/);
});

/**
 * 用真實專案的 wrangler.jsonc 格式建一個最小測試目錄——照抄
 * `要部署的專案/電阻識別測驗APP/wrangler.jsonc` 的實際寫法（含註解），
 * 確保這裡測的是會真的出現的格式，不是憑空想像的簡化版。
 *
 * @param {string} [wranglerBody]
 * @returns {string}
 */
function makeTargetProject(wranglerBody) {
  const dir = mkdtempSync(join(tmpdir(), "inject-gate-"));

  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>t</title>\n");
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    wranglerBody ??
      `{
	// 靜態網站專用（static-only Worker）：沒有 "main"，只有 assets。
	// 沒有伺服器端程式碼，因此不需要 D1、R2 或任何 binding。
	"name": "resistor-quiz",
	"compatibility_date": "2026-08-08",

	// ⚠️ assets 目錄嚴禁指向專案根目錄。
	"assets": {
		"directory": "./public/"
	}
}
`,
  );

  return dir;
}

test("injectGate preserves every existing comment verbatim, only adding the two required fields", () => {
  const dir = makeTargetProject();

  injectGate(dir, { projectId: 42, visibility: "private", policyVersion: 1, projectName: "電阻識別測驗" });

  const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");

  for (const comment of [
    "靜態網站專用（static-only Worker）",
    "沒有伺服器端程式碼，因此不需要 D1、R2 或任何 binding",
    "assets 目錄嚴禁指向專案根目錄",
  ]) {
    assert.ok(text.includes(comment), `註解不該被抹掉：${comment}`);
  }

  assert.match(text, /"main":\s*"\.\/hub-gate-entry\.js"/);
  assert.match(text, /"binding":\s*"ASSETS"/);
  assert.match(text, /"run_worker_first":\s*\["\/\*"\]/);
  assert.match(text, /"name":\s*"resistor-quiz"/, "原有欄位不該消失");
});

test("injectGate's result is valid JSONC that Wrangler could actually parse", () => {
  const dir = makeTargetProject();

  injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" });

  const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const parsed = JSON.parse(withoutComments);

  assert.equal(parsed.main, "./hub-gate-entry.js");
  assert.equal(parsed.assets.directory, "./public/");
  assert.equal(parsed.assets.binding, "ASSETS");
  assert.deepEqual(parsed.assets.run_worker_first, ["/*"]);
});

test("injectGate copies the whole self-contained access-gate directory", () => {
  const dir = makeTargetProject();

  injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" });

  const copied = readdirSync(join(dir, GATE_DIR_NAME)).sort();

  assert.deepEqual(copied, ["index.js", "password.js", "protected-worker.js", "session.js"]);
  assert.ok(readFileSync(join(dir, GATE_ENTRY_FILENAME), "utf8").includes("createProtectedWorker"));
});

test("injectGate refuses a project that already has its own main, and touches nothing", () => {
  const dir = makeTargetProject(`{
	"name": "already-a-worker",
	"main": "src/index.js",
	"compatibility_date": "2026-08-08"
}
`);

  const before = readFileSync(join(dir, "wrangler.jsonc"), "utf8");

  assert.throws(
    () => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" }),
    /main/,
  );

  const after = readFileSync(join(dir, "wrangler.jsonc"), "utf8");

  assert.equal(after, before, "拒絕注入時不該動到任何檔案");
});

test("injectGate does not mistake a comment that merely mentions \"main\" for a real main field", () => {
  // 2026-08-25 由獨立驗證 agent 發現的真實問題：早期版本直接對含註解的
  // 原始文字比對 /"main"\s*:/，會被這種說明性註解誤導成「已經有 main」，
  // 錯誤拒絕一個其實合法的靜態專案。
  const dir = makeTargetProject(`{
	// 這是純靜態網站，沒有 "main"，只有 assets。
	// 對照：worker 型專案的設定會像這樣：// "main": "old-entry.js"
	"name": "resistor-quiz",
	"compatibility_date": "2026-08-08",
	"assets": {
		"directory": "./public/"
	}
}
`);

  assert.doesNotThrow(() =>
    injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" }),
  );

  const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");

  assert.match(text, /"main":\s*"\.\/hub-gate-entry\.js"/);
});

test("injectGate does not mistake a comment mentioning binding/run_worker_first for an existing injection", () => {
  const dir = makeTargetProject(`{
	// 之後若要加保護，assets 區塊會多出 "binding" 與 "run_worker_first"。
	"name": "resistor-quiz",
	"compatibility_date": "2026-08-08",
	"assets": {
		"directory": "./public/"
	}
}
`);

  assert.doesNotThrow(() =>
    injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" }),
  );
});

test("injectGate refuses (rather than silently double-inject) a project that already has a run_worker_first", () => {
  const dir = makeTargetProject(`{
	"name": "already-injected",
	"compatibility_date": "2026-08-08",
	"assets": {
		"directory": "./public/",
		"binding": "ASSETS",
		"run_worker_first": ["/*"]
	}
}
`);

  assert.throws(
    () => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" }),
    /binding.*run_worker_first|已經有/i,
  );
});

test("injectGate throws (does not silently skip) when wrangler.jsonc has no assets block at all", () => {
  const dir = makeTargetProject(`{
	"name": "no-assets",
	"compatibility_date": "2026-08-08"
}
`);

  assert.throws(() => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" }));
});

test("injectGate throws when the target has no wrangler.jsonc at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "inject-gate-empty-"));

  assert.throws(() => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" }));
});

// ── isOwnGateAlreadyInjected：分辨「自己上次注入的殘留」與「別人的 Worker 專案」 ──

test("isOwnGateAlreadyInjected returns true when all three of its own signals are present", () => {
  const dir = makeTargetProject();

  injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t" });

  assert.equal(isOwnGateAlreadyInjected(dir), true);
});

test("isOwnGateAlreadyInjected returns false when main matches but hub-gate-entry.js does not exist", () => {
  const dir = makeTargetProject(`{
	"name": "already-a-worker",
	"main": "./${GATE_ENTRY_FILENAME}",
	"compatibility_date": "2026-08-08"
}
`);

  // 只有 main 欄位巧合寫對了字面值，沒有進入點檔案、也沒有 access-gate/ 目錄。
  assert.equal(isOwnGateAlreadyInjected(dir), false);
});

test("isOwnGateAlreadyInjected returns false when main matches but hub-gate-entry.js is someone else's file, not ours", () => {
  // 這是防偽陽性的關鍵測試：main 欄位的字面值巧合相符，且檔案確實存在，
  // 但內容不是 renderGateEntry() 產生的（模擬別人自己寫了一個同名檔案）——
  // 不能只測「檔案不存在」這一種情況，否則測不到 GATE_ENTRY_MARKER 那道檢查。
  const dir = makeTargetProject(`{
	"name": "already-a-worker",
	"main": "./${GATE_ENTRY_FILENAME}",
	"compatibility_date": "2026-08-08"
}
`);

  writeFileSync(
    join(dir, GATE_ENTRY_FILENAME),
    "export default { fetch() { return new Response('這是別人自己寫的檔案，不是 hub ship 產生的'); } };\n",
  );
  mkdirSync(join(dir, GATE_DIR_NAME));

  assert.equal(isOwnGateAlreadyInjected(dir), false);
});

test("isOwnGateAlreadyInjected returns false when only the access-gate/ directory exists", () => {
  const dir = makeTargetProject();

  mkdirSync(join(dir, GATE_DIR_NAME));

  assert.equal(isOwnGateAlreadyInjected(dir), false);
});

test("isOwnGateAlreadyInjected returns false for an ordinary project with none of these traces", () => {
  const dir = makeTargetProject();

  assert.equal(isOwnGateAlreadyInjected(dir), false);
});

// ── 端到端：注入後的程式碼實際跑起來會不會真的擋住訪客 ──

test("end to end: the injected worker actually blocks an unauthenticated visitor from a private project", async () => {
  const dir = makeTargetProject();

  injectGate(dir, { projectId: 42, visibility: "private", policyVersion: 1, projectName: "電阻識別測驗" });

  // 動態載入剛剛產生的進入點檔案，模擬 Cloudflare 執行這個 Worker。
  // 用 pathToFileURL 而不是手拼字串——Windows 的磁碟機代號（例如 C:\）
  // 不是合法的 file:// URL，手拼字串在 Windows 上會直接被 ESM loader 拒絕。
  const entryUrl = pathToFileURL(join(dir, "hub-gate-entry.js"));

  entryUrl.search = `?t=${Date.now()}`;

  const mod = await import(entryUrl.href);
  const assetCalls = [];

  const env = {
    SESSION_SIGNING_KEY: "end-to-end-test-signing-key-0123456789",
    ASSETS: {
      async fetch(request) {
        assetCalls.push(new URL(request.url).pathname);
        return new Response("SITE CONTENT");
      },
    },
  };

  const response = await mod.default.fetch(new Request("https://example.test/"), env, {
    waitUntil() {},
    passThroughOnException() {},
  });

  assert.equal(response.status, 404, "private 專案在沒有管理者身分時必須一律拒絕");
  assert.equal(assetCalls.length, 0, "被拒絕的請求不該碰到任何靜態資源");
});
