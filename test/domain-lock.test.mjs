/**
 * 網域鎖（2026-08-30）。
 *
 * 這個功能的價值取決於一件事被講清楚：**它是嚇阻，不是保護。**
 * 所以測試除了驗行為，也釘住「輸出訊息有沒有把界線說出來」——
 * 使用者以為它是保護，會讓他把真正該保密的東西留在網頁裡，
 * 那比沒有這個功能更危險。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyDomainLock,
  applyLockToHtml,
  findHtmlFiles,
  LOCK_END,
  LOCK_START,
  removeLockFromHtml,
  renderLockScript,
  resolveAssetsDir,
} from "../tools/domain-lock.mjs";

const PAGE = "<html><head><title>測驗</title></head><body><p>題目</p></body></html>";

function makeProject(files) {
  const dir = mkdtempSync(join(tmpdir(), "hub-lock-"));

  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    const parent = full.slice(0, Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\")));

    mkdirSync(parent, { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  return dir;
}

// ── 注入與移除 ──────────────────────────────────────────────

test("注入之後再移除，會回到一模一樣的原檔", () => {
  /*
   * 這一條最重要。移除如果留下殘渣，使用者的 HTML 會被我們慢慢改壞，
   * 而且每跑一次就多一點——那種損壞很難回頭追。
   */
  const added = applyLockToHtml(PAGE, "my-quiz");

  assert.equal(added.changed, true);
  assert.equal(removeLockFromHtml(added.html).html, PAGE);
});

test("重複注入不會疊加（冪等）", () => {
  const once = applyLockToHtml(PAGE, "my-quiz");
  const twice = applyLockToHtml(once.html, "my-quiz");

  assert.equal(twice.changed, false);
  assert.equal(twice.html, once.html);
  assert.equal(twice.html.split(LOCK_START).length - 1, 1, "起始標記只能出現一次");
});

test("注入位置在 </head> 之前", () => {
  const html = applyLockToHtml(PAGE, "my-quiz").html;

  assert.ok(html.indexOf(LOCK_START) < html.indexOf("</head>"));
  assert.ok(html.indexOf(LOCK_END) < html.indexOf("</head>"));
});

test("沒有 </head> 的片段也處理得了", () => {
  // 真實使用者的 HTML 不保證結構完整，缺 head 不該讓指令整個失敗。
  const fragment = "<body><p>hi</p></body>";
  const result = applyLockToHtml(fragment, "my-quiz");

  assert.equal(result.changed, true);
  assert.ok(result.html.startsWith(LOCK_START));
  assert.equal(removeLockFromHtml(result.html).html, fragment);
});

test("只有起始標記時拒絕自動移除，不猜範圍", () => {
  /*
   * 檔案被手動改壞的情況下，猜要刪到哪裡等於拿使用者的網頁賭。
   * 寧可報錯要他自己看。
   */
  const broken = `${LOCK_START}\n<script>...</script>\n${PAGE}`;

  assert.throws(() => removeLockFromHtml(broken), /找不到結束標記/);
});

test("沒有鎖的檔案，移除是無動作", () => {
  const result = removeLockFromHtml(PAGE);

  assert.equal(result.changed, false);
  assert.equal(result.html, PAGE);
});

// ── 腳本內容 ────────────────────────────────────────────────

test("腳本放行 localhost，攔下 file:// 與別的網域", () => {
  const script = renderLockScript("my-quiz");

  // 放行本機：作者要能用 wrangler dev 測試。擋掉 localhost 的代價全部由
  // 作者承擔，而複製的人起一個本機伺服器就繞過，效果幾乎是零。
  assert.match(script, /localhost/);
  assert.match(script, /127\.0\.0\.1/);
  assert.match(script, /file:/);
  // 代稱要帶著點，否則 my-quiz-copy.workers.dev 也會被當成自己人。
  assert.ok(script.includes('"my-quiz."'), "比對字串必須是「代稱＋點」");
});

test("腳本不使用 innerHTML", () => {
  // AGENTS.md 第 8 節：網頁文字一律用 textContent。注入的腳本自己也要守，
  // 不然就是一邊寫規則一邊違反它。
  const script = renderLockScript("my-quiz");

  assert.equal(/innerHTML|outerHTML|document\.write/.test(script), false);
  assert.match(script, /textContent/);
});

test("不合格式的代稱直接拒絕，不試圖跳脫", () => {
  /*
   * 跳脫寫錯了會靜默產生一份壞掉的 HTML，要等到有人打開網頁才發現。
   * 丟例外則是當場就知道。slug 在上游已經被驗過，這裡是第二道防線。
   */
  for (const bad of ["a</script><script>x()</script>", 'evil");alert(1);//', "Evil", "with space", ""]) {
    assert.throws(() => renderLockScript(bad), /不合格式/, `${bad} 應該被拒絕`);
  }

  // 合格的代稱照常產生，而且是完整的字串字面值。
  assert.ok(renderLockScript("my-quiz").includes('"my-quiz."'));
});

// ── 找檔案與目錄 ────────────────────────────────────────────

test("找得到巢狀的 HTML，且跳過 node_modules 與工具產物", () => {
  const dir = makeProject({
    "index.html": PAGE,
    "pages/second.html": PAGE,
    "node_modules/pkg/x.html": PAGE,
    ".wrangler/tmp/y.html": PAGE,
  });

  try {
    const found = findHtmlFiles(dir).map((p) => p.replace(dir, "").replace(/\\/g, "/"));

    assert.equal(found.length, 2, JSON.stringify(found));
    assert.ok(found.some((p) => p.endsWith("/index.html")));
    assert.ok(found.some((p) => p.endsWith("/pages/second.html")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("有 public/ 時只處理 public/，不碰專案根目錄的 HTML", () => {
  /*
   * 根目錄的 HTML 不會被上傳（wrangler 只送 assets 目錄）。注入到那裡
   * 是完全靜默的失敗：指令回報成功，線上卻沒有那段腳本。
   */
  const dir = makeProject({ "public/index.html": PAGE, "說明.html": PAGE });

  try {
    assert.ok(resolveAssetsDir(dir).endsWith("public"));

    const result = applyDomainLock({ dir, slug: "my-quiz" });

    assert.equal(result.files.length, 1);
    assert.ok(result.files[0].path.includes("public"));
    assert.equal(readFileSync(join(dir, "說明.html"), "utf8"), PAGE, "根目錄的 HTML 不該被動到");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("沒有 public/ 時退回專案根目錄", () => {
  const dir = makeProject({ "index.html": PAGE });

  try {
    assert.equal(resolveAssetsDir(dir), dir);
    assert.equal(applyDomainLock({ dir, slug: "my-quiz" }).files.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("整個專案加了再移除，每個檔案都回到原狀", () => {
  const dir = makeProject({ "public/index.html": PAGE, "public/b/second.html": PAGE });

  try {
    applyDomainLock({ dir, slug: "my-quiz" });

    assert.notEqual(readFileSync(join(dir, "public", "index.html"), "utf8"), PAGE);

    const removed = applyDomainLock({ dir, slug: "my-quiz", remove: true });

    assert.equal(removed.files.filter((f) => f.changed).length, 2);
    assert.equal(readFileSync(join(dir, "public", "index.html"), "utf8"), PAGE);
    assert.equal(readFileSync(join(dir, "public", "b", "second.html"), "utf8"), PAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
