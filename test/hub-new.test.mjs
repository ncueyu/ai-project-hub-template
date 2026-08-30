/**
 * `hub new <資料夾>` 的測試（2026-08-29）。
 *
 * 這支工具會**搬動使用者既有的檔案**，所以測試的重心不是「跑得動」，
 * 而是「不會在使用者沒同意的情況下動他的東西」與「不會覆寫他已經有的設定」。
 * 搬錯或覆寫掉的檔案，使用者很可能沒有第二份。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rejectUnexpectedPositional, resolveRemote } from "../bin/hub.mjs";
import { newProject, planMove, renderManifest, renderWranglerConfig, suggestSlug } from "../tools/new-project.mjs";

/** 造一個丟棄式的專案資料夾。 */
function makeProject(files = { "index.html": "<h1>我的班網</h1>" }, name = "hub-new-") {
  const dir = mkdtempSync(join(tmpdir(), name));

  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    const parent = full.slice(0, Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\")));
    if (parent && parent !== dir) mkdirSync(parent, { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  return dir;
}

const ALWAYS_YES = async () => true;
const ALWAYS_NO = async () => false;

/** 依序回答的假 prompt。 */
function answers(...values) {
  let i = 0;
  return async () => values[i++] ?? "";
}

/* ==========================================================================
 * 階段 1：hub init 不再靜默忽略位置參數
 * ========================================================================== */

test("hub init 收到資料夾參數時被擋下，並指出正確的指令", () => {
  /*
   * 這是本專案最危險的一個打錯方向：`hub init` 會建立 D1 資料庫並**部署到
   * Cloudflare**，而它原本完全不讀位置參數，所以 `hub init 我的網頁` 會靜默
   * 丟掉那個路徑、直接跑展示中心的初始化。而 `init <資料夾>` 正是「初始化一個
   * 待部署專案」最自然的猜法。
   *
   * 測純函式而不是測 main()：main(["init","x"]) 一旦守衛失效就會真的去執行
   * initHub。測試不該有那種可能性。
   */
  const message = rejectUnexpectedPositional("init", ["要部署的專案/我的網頁"]);

  assert.ok(message, "init 帶資料夾參數必須被擋下");
  assert.match(message, /展示中心自己/);
  assert.match(message, /hub\.mjs new/, "必須告訴使用者正確的指令是什麼，不能只說錯了");
});

test("hub init 不帶參數時不受影響", () => {
  assert.equal(rejectUnexpectedPositional("init", []), null);
});

test("吃位置參數的指令不受這個守衛影響", () => {
  for (const command of ["ship", "check", "detect", "status", "new", "pitfalls"]) {
    assert.equal(rejectUnexpectedPositional(command, ["something"]), null, `${command} 不該被擋`);
  }
});

/* ==========================================================================
 * 階段 2：hub new 的行為
 * ========================================================================== */

test("單一 HTML 檔的資料夾會被整理成可部署的結構", async () => {
  const dir = makeProject({ "index.html": "<h1>hi</h1>", "style.css": "body{}" });

  const result = await newProject({
    dir,
    confirm: ALWAYS_YES,
    prompt: answers("我的班網", "my-class-site"),
  });

  assert.equal(result.ok, true);
  assert.ok(existsSync(join(dir, "public", "index.html")), "網頁應該被搬進 public/");
  assert.ok(existsSync(join(dir, "public", "style.css")));
  assert.ok(existsSync(join(dir, "wrangler.jsonc")));
  assert.ok(existsSync(join(dir, "project-hub.json")));

  const manifest = JSON.parse(readFileSync(join(dir, "project-hub.json"), "utf8"));
  assert.equal(manifest.name, "我的班網");
  assert.equal(manifest.slug, "my-class-site");
  assert.equal(manifest.project_type, "static");
});

test("使用者拒絕搬移時，一個檔案都不動", async () => {
  const dir = makeProject({ "index.html": "<h1>hi</h1>" });

  const result = await newProject({ dir, confirm: ALWAYS_NO, prompt: answers("x", "x") });

  assert.equal(result.ok, false);
  assert.ok(existsSync(join(dir, "index.html")), "檔案應該留在原處");
  assert.equal(existsSync(join(dir, "public")), false, "不該建立 public/");
  assert.equal(existsSync(join(dir, "wrangler.jsonc")), false, "拒絕後不該留下任何設定檔");
});

test("已經有 public/ 時不搬動，只補缺的設定檔", async () => {
  const dir = makeProject({ "public/index.html": "<h1>hi</h1>" });

  const result = await newProject({ dir, confirm: ALWAYS_NO, prompt: answers("站", "my-site") });

  // confirm 是 ALWAYS_NO，但因為根本不需要搬移，所以不會問，也就不會被拒絕。
  assert.equal(result.ok, true);
  assert.ok(existsSync(join(dir, "public", "index.html")));
  assert.ok(existsSync(join(dir, "wrangler.jsonc")));
});

test("既有的設定檔不會被覆寫", async () => {
  const dir = makeProject({
    "public/index.html": "<h1>hi</h1>",
    "wrangler.jsonc": "{ /* 我自己調過的設定 */ }",
    "project-hub.json": '{"name":"原本的名字","slug":"original"}',
  });

  await newProject({ dir, confirm: ALWAYS_YES, prompt: answers("新名字", "new-slug") });

  assert.match(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), /我自己調過的設定/);
  assert.match(readFileSync(join(dir, "project-hub.json"), "utf8"), /原本的名字/);
});

test("找不到任何 HTML 時停下並說明，不建空白頁", async () => {
  // 刻意不猜：使用者要部署的是他自己做的東西，硬建一個 index.html 只會讓他
  // 部署出一個不是他做的網頁，而且不知道那是哪來的。
  const dir = makeProject({ "筆記.txt": "還沒開始做" });

  const result = await newProject({ dir, confirm: ALWAYS_YES, prompt: answers("x", "x") });

  assert.equal(result.ok, false);
  assert.equal(existsSync(join(dir, "public")), false);
  assert.match(result.steps.at(-1).detail, /找不到任何 \.html/);
});

test("拒絕處理 Worker 型專案（展示中心自己就是這一種）", async () => {
  const dir = makeProject({
    "index.html": "<h1>hi</h1>",
    "wrangler.jsonc": '{ "name": "hub", "main": "src/index.js" }',
  });

  const result = await newProject({ dir, confirm: ALWAYS_YES, prompt: answers("x", "x") });

  assert.equal(result.ok, false);
  assert.match(result.steps.at(-1).detail, /main/);
  assert.equal(existsSync(join(dir, "public")), false, "拒絕時不該動任何東西");
});

test("縮圖與設定檔留在根目錄，不會被搬進 public/", async () => {
  // 縮圖是給展示中心用的中介資料，不是那個網站的內容；設定檔搬進去會被當成
  // 網站檔案公開上傳。
  const dir = makeProject({ "index.html": "<h1>hi</h1>", "thumbnail.png": "fake", "README.md": "說明" });

  await newProject({ dir, confirm: ALWAYS_YES, prompt: answers("站", "my-site") });

  assert.ok(existsSync(join(dir, "thumbnail.png")), "縮圖應留在根目錄");
  assert.ok(existsSync(join(dir, "README.md")), "README 應留在根目錄");
  assert.equal(existsSync(join(dir, "public", "thumbnail.png")), false);
});

test("slug 不合格時重問，連續給錯就停下而不是無限迴圈", async () => {
  const dir = makeProject({ "public/index.html": "<h1>hi</h1>" }, "hub-new-badslug-");

  const result = await newProject({
    dir,
    confirm: ALWAYS_YES,
    // 名稱一次，之後全部是不合格的 slug（大寫、中文、底線）
    prompt: answers("站", "MySite", "我的站", "my_site", "MySite", "我的站", "my_site"),
  });

  assert.equal(result.ok, false);
  assert.match(result.steps.at(-1).detail, /網址代稱/);
});

test("suggestSlug 對中文回 null，對英文資料夾名給得出建議", () => {
  assert.equal(suggestSlug("我的班網"), null, "中文不做音譯——slug 會變成永久網址");
  assert.equal(suggestSlug("My Class Site"), "my-class-site");
  assert.equal(suggestSlug("quiz-app"), "quiz-app");
});

test("產生的 wrangler.jsonc 沒有 main、assets 不指向根目錄", () => {
  const text = renderWranglerConfig("my-site", "2026-08-08");

  // 檢查真正的欄位（`"main":`）而不是「文字裡有沒有 main」——註解裡就寫著
  // 「沒有 "main"，只有 assets」，用後者比對會誤判。專案既有的
  // inject-gate.mjs 也是先 stripJsoncComments 再比對欄位。
  assert.doesNotMatch(text, /"main"\s*:/, "有 main 會讓 detect 判成 worker，而 hub ship 只處理純靜態");
  assert.match(text, /"directory": "\.\/public\/"/);
  assert.doesNotMatch(text, /"directory": "\.\/"/, "assets 指向根目錄會把暫存檔與設定檔一起上傳");
});

test("產生的 project-hub.json 是 private，與實際登錄行為一致", () => {
  // register.mjs 對新專案一律回 private 並忽略這個檔寫的值，寫 public 會是誤導。
  const manifest = JSON.parse(renderManifest("我的班網", "my-class-site"));
  assert.equal(manifest.visibility, "private");
});

test("planMove 把設定檔與縮圖排除在搬移清單之外", () => {
  const dir = makeProject({
    "index.html": "<h1>hi</h1>",
    "app.js": "//",
    "thumbnail.png": "fake",
    "project-hub.json": "{}",
  });

  const plan = planMove(dir);

  assert.deepEqual(plan.toMove.sort(), ["app.js", "index.html"]);
  assert.deepEqual(plan.htmlFiles, ["index.html"]);
  assert.equal(plan.hasAssetsDir, false);
});

/* ==========================================================================
 * ship 預設走遠端 D1（2026-08-29 修正的缺陷）
 * ========================================================================== */

test("hub ship 不帶旗標時登錄到遠端資料庫", () => {
  /*
   * 這個缺陷的失敗方式是完全靜默的：部署每一步都顯示成功，GitHub 也真的推了、
   * Cloudflare 也真的部署了，只有登錄寫進本機模擬資料庫。使用者打開自己的
   * 展示中心看不到那個專案，進後台也找不到它——而 AGENTS.md 教的指令
   * （`hub ship 要部署的專案/XXX`）正是不帶 --remote 的那一種。
   */
  assert.equal(resolveRemote("ship", {}, false), true);
});

test("hub ship 帶 --local 時才寫本機", () => {
  assert.equal(resolveRemote("ship", { local: true }, false), false);
});

test("查詢類指令不受影響，維持依旗標判斷", () => {
  // list／status 是唯讀查詢，本機預設很合理，不該被一起改掉。
  assert.equal(resolveRemote("list", {}, false), false);
  assert.equal(resolveRemote("list", { remote: true }, true), true);
  assert.equal(resolveRemote("status", {}, false), false);
});
