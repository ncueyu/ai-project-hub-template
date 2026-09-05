import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  GATE_DIR_NAME,
  GATE_ENTRY_FILENAME,
  HUB_DB_BINDING,
  ensureHubDbBinding,
  generateSigningKey,
  injectGate,
  isOwnGateAlreadyInjected,
  readHubDatabase,
  renderGateEntry,
} from "../tools/inject-gate.mjs";
import { hasRemoteDatabase, readWranglerConfig } from "../tools/config.mjs";

/*
 * 空殼（剛下載的範本）還沒跑過 `node bin/hub.mjs init`，wrangler.jsonc 的
 * database_id 是佔位值（前 8 碼全是 0）。標了 { skip: NO_HUB_DB } 的測試需要
 * 一個真的 Hub 資料庫設定才跑得起來——在那個狀態下它們**應該跳過，不是失敗**。
 * 理由與 test/hub-ship.test.mjs 同一條（見該檔說明）。
 */
const NO_HUB_DB = hasRemoteDatabase()
  ? false
  : "尚未建立線上資料庫（wrangler.jsonc 的 database_id 是佔位值）——先執行 node bin/hub.mjs init";


/*
 * `needsGateInjection` 的測試已於 2026-09-04 移除，連同那個函式本身。
 * 它的作用是「只有受保護的權限才注入閘道」，而那正是「後台改成公開之後
 * 線上仍然 404、重新部署也修不好」的成因。現在一律注入，見
 * `tools/ship.mjs` 注入那一段的說明。
 */

/** 測試用的假資料庫設定，不去讀 Hub 真正的 wrangler.jsonc。 */
const TEST_DB = { databaseName: "test-db", databaseId: "11111111-2222-3333-4444-555555555555" };

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

  injectGate(dir, { projectId: 42, visibility: "private", policyVersion: 1, projectName: "電阻識別測驗", database: TEST_DB });

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

  injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB });

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

  injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB });

  const copied = readdirSync(join(dir, GATE_DIR_NAME)).sort();

  assert.deepEqual(copied, ["index.js", "password.js", "policy-lookup.js", "protected-worker.js", "session.js"]);
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
    () => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB }),
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
    injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB }),
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
    injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB }),
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
    () => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB }),
    /binding.*run_worker_first|已經有/i,
  );
});

test("injectGate throws (does not silently skip) when wrangler.jsonc has no assets block at all", () => {
  const dir = makeTargetProject(`{
	"name": "no-assets",
	"compatibility_date": "2026-08-08"
}
`);

  assert.throws(() => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB }));
});

test("injectGate throws when the target has no wrangler.jsonc at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "inject-gate-empty-"));

  assert.throws(() => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB }));
});

// ── isOwnGateAlreadyInjected：分辨「自己上次注入的殘留」與「別人的 Worker 專案」 ──

test("isOwnGateAlreadyInjected returns true when all three of its own signals are present", () => {
  const dir = makeTargetProject();

  injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB });

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

  injectGate(dir, { projectId: 42, visibility: "private", policyVersion: 1, projectName: "電阻識別測驗", database: TEST_DB });

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

// ── D1 綁定：權限即時生效的前提（2026-09-04） ──

test("injectGate 會寫入 Hub 的 D1 綁定，否則閘道查不到權限", () => {
  const dir = makeTargetProject();

  injectGate(dir, { projectId: 42, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB });

  const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  const parsed = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"));
  const entry = parsed.d1_databases?.find((row) => row.binding === HUB_DB_BINDING);

  assert.ok(entry, `應該有 ${HUB_DB_BINDING} 綁定`);
  assert.equal(entry.database_name, TEST_DB.databaseName);
  assert.equal(entry.database_id, TEST_DB.databaseId);
});

test("綁定名稱不叫 DB——會跟使用者專案自己的資料庫撞名", () => {
  assert.equal(HUB_DB_BINDING, "HUB_DB");
});

test("產生的進入點會把 env.HUB_DB 接進即時查詢", () => {
  const source = renderGateEntry({ projectId: 7, visibility: "private", policyVersion: 1, projectName: "t" });

  assert.match(source, /import \{ createPolicyLookup \} from "\.\/access-gate\/policy-lookup\.js"/);
  assert.match(source, /resolvePolicy: createPolicyLookup\(\{ db: env\.HUB_DB, projectId: PROJECT_ID \}\)/);

  // 與 PROJECT_PASSWORD_HASH 同理：env 只有進了 fetch() 才存在。
  assert.ok(source.indexOf("env.HUB_DB, projectId") > source.indexOf("fetch(request, env, ctx)"));
});

test("ensureHubDbBinding 補上舊專案缺的綁定，且可以重複執行", () => {
  const dir = makeTargetProject();

  // 先注入一份「舊版」的閘道：有 main、有 assets 補丁，但沒有 d1_databases。
  injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB });

  const withBinding = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  const legacy = withBinding.replace(/\t"d1_databases": \[[\s\S]*?\t\],\n/, "");

  assert.ok(!legacy.includes("d1_databases"), "測試前提：這份設定沒有 d1_databases");
  writeFileSync(join(dir, "wrangler.jsonc"), legacy);

  assert.equal(ensureHubDbBinding(dir, TEST_DB), true, "第一次應該真的補上");
  assert.equal(ensureHubDbBinding(dir, TEST_DB), false, "第二次應該什麼都不做");

  const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");

  assert.match(text, /"binding":\s*"HUB_DB"/);
  assert.match(text, /"main":\s*"\.\/hub-gate-entry\.js"/, "不該動到既有欄位");
});

test("專案自己已經有 d1_databases 時停下來說清楚，不自動合併陣列", () => {
  const dir = makeTargetProject(`{
	"name": "has-own-db",
	"compatibility_date": "2026-08-08",
	"d1_databases": [
		{ "binding": "MY_DB", "database_name": "teacher-notes", "database_id": "aaaa" }
	],
	"assets": {
		"directory": "./public/"
	}
}
`);

  assert.throws(
    () => injectGate(dir, { projectId: 1, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB }),
    /HUB_DB/,
    "錯誤訊息要指名缺的是哪個綁定，讓使用者知道要手動加什麼",
  );
});

test("佔位的 database_id 會被認出來——沒認出來就會部署出一個連不到資料庫的專案", () => {
  /*
   * 剛下載範本、還沒跑 hub init 時，database_id 是佔位值（前 8 碼全是 0）。
   * 把它寫進使用者的專案設定檔，wrangler deploy 會失敗在一個跟真正原因
   * 無關的訊息上——他會以為是自己的網頁壞了。
   *
   * 這裡用假設定檔測，不改真的 wrangler.jsonc。這一條在空殼裡同樣成立，
   * 所以**不跳過**：它守的是判準本身，與本專案初始化了沒有無關。
   */
  const placeholder = { d1_databases: [{ database_name: "x", database_id: "00000000-0000-0000-0000-000000000000" }] };

  assert.equal(hasRemoteDatabase(placeholder), false, "佔位值必須被認出來");
});

test("本專案已經建立過線上資料庫", { skip: NO_HUB_DB }, () => {
  // 從上一條拆出來（2026-09-06）：這句斷言的是「這一份 checkout 初始化過了」，
  // 在空殼裡依設計就是假的，混在同一條測試裡會讓老師看到一個無法解釋的失敗。
  assert.equal(hasRemoteDatabase(readWranglerConfig()), true);
});

test("readHubDatabase 讀得到本專案自己的 D1 設定", { skip: NO_HUB_DB }, () => {
  // 綁到真實設定檔的唯一一條測試：寫死名稱與 id 會讓別人照教材建自己一套時
  // 安靜地綁到不存在的資料庫，所以要確認這條讀取路徑真的通。
  const database = readHubDatabase();

  assert.ok(database.databaseName.length > 0);
  assert.match(database.databaseId, /^[0-9a-f-]{36}$/i);
});

test("端到端：資料庫說 public，檔案裡烙的是 private —— 訪客應該進得去", async () => {
  const dir = makeTargetProject();

  injectGate(dir, { projectId: 42, visibility: "private", policyVersion: 1, projectName: "t", database: TEST_DB });

  const entryUrl = pathToFileURL(join(dir, "hub-gate-entry.js"));

  entryUrl.search = `?t=${Date.now()}-live`;

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
    // 使用者在後台把它改成公開了，但沒有重新部署。
    HUB_DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { visibility: "public", policy_version: 1, password_hash: null };
              },
            };
          },
        };
      },
    },
  };

  const response = await mod.default.fetch(new Request("https://example.test/"), env, {
    waitUntil() {},
    passThroughOnException() {},
  });

  assert.equal(response.status, 200, "這一條就是整個改動的存在理由：改權限不必重新部署");
  assert.deepEqual(assetCalls, ["/"]);
});
