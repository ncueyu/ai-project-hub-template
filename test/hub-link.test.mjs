/**
 * `hub link`——外部連結專案（2026-08-30，縮圖與外部連結專案計畫階段 5）。
 *
 * 這個指令的風險集中在兩件事，測試的重心也放在那裡：
 *
 *   1. **誤判**：把一個真的要部署的專案判成「外部連結」，`hub ship` 於是拒絕
 *      部署一個本來部署得起來的專案。
 *   2. **誤蓋**：用一個已經存在的代稱跑 link，把那張卡片的連結改指到別的網站，
 *      或悄悄清掉它的 GitHub 網址與 Worker 名稱。
 *
 * 全部測試都不碰網路、不碰 Wrangler——`linkProject()` 的注入點就是為此存在。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planBuild } from "../tools/build-plan.mjs";
import { detectProject } from "../tools/detect.mjs";
import {
  decodeTextFile,
  detectLinkFolder,
  extractUrl,
  findLinkFile,
} from "../tools/link-detect.mjs";
import { fetchPageMeta, linkProject, parsePageMeta, suggestSlugFromUrl } from "../tools/link.mjs";

/**
 * 建一個暫時的資料夾，測完刪掉。
 *
 * @param {Record<string, string>} files
 * @returns {string}
 */
function makeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "hub-link-test-"));

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }

  return dir;
}

// ── 取出網址 ────────────────────────────────────────────────

test("extractUrl 認得 http 與 https，並切掉尾端標點", () => {
  assert.equal(extractUrl("https://example.com/abc"), "https://example.com/abc");
  assert.equal(extractUrl("網址：https://example.com/abc。"), "https://example.com/abc");
  assert.equal(extractUrl("請看 https://example.com/abc，謝謝"), "https://example.com/abc");
  assert.equal(extractUrl("http://example.com/"), "http://example.com/");
});

test("extractUrl 不接受非 http(s) 的協定", () => {
  // file:// 與 javascript: 進到 deployment_url 之後會變成卡片上可點的連結。
  assert.equal(extractUrl("file:///C:/secret.txt"), null);
  assert.equal(extractUrl("javascript:alert(1)"), null);
  assert.equal(extractUrl("ftp://example.com/x"), null);
  assert.equal(extractUrl("這個檔案裡沒有網址"), null);
  assert.equal(extractUrl(""), null);
});

test("decodeTextFile 認得 UTF-16 與 BOM", () => {
  /*
   * Windows 記事本的「另存新檔」提供 UTF-16 LE（選單上寫「Unicode」）。
   * 以 utf8 讀那種檔，每個字元中間會多一個 NUL，網址一個字元都比對不到，
   * 而錯誤訊息只會是「找不到網址」——使用者明明看著檔案裡就有。
   */
  const url = "https://example.com/";

  assert.equal(decodeTextFile(Buffer.from(url, "utf8")), url);
  assert.equal(
    decodeTextFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(url, "utf8")])),
    url,
  );
  assert.equal(
    decodeTextFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(url, "utf16le")])),
    url,
  );

  const be = Buffer.from(url, "utf16le");

  be.swap16();

  assert.equal(decodeTextFile(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), url);
});

// ── 找檔案 ──────────────────────────────────────────────────

test("findLinkFile 認得任何 .txt／.md，不限定檔名", () => {
  const dir = makeDir({ "我的班網.md": "https://class.example.com/" });

  try {
    assert.equal(findLinkFile(dir)?.url, "https://class.example.com/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同一個資料夾有多個文字檔時，計畫書點名的檔名優先", () => {
  const dir = makeDir({
    "aaa-隨手筆記.txt": "https://wrong.example.com/",
    "連結.txt": "https://right.example.com/",
  });

  try {
    // 沒有優先序的話，結果會隨 readdir 的順序而變——同一個資料夾兩次執行
    // 可能登錄到不同的網站，而且完全不會有人發現。
    assert.equal(findLinkFile(dir)?.name, "連結.txt");
    assert.equal(findLinkFile(dir)?.url, "https://right.example.com/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("只看根目錄，不遞迴", () => {
  const dir = makeDir({});

  try {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "連結.txt"), "https://example.com/", "utf8");

    assert.equal(findLinkFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 誤判防線 ────────────────────────────────────────────────

test("有 HTML 的資料夾一律不是外部連結專案", () => {
  /*
   * 這是最重要的一條。一個正常的靜態專案很可能也放了一個寫著網址的
   * readme.md；判成外部連結的話，`hub ship` 會拒絕部署一個本來
   * 部署得起來的專案，而錯誤訊息還會叫他去用 `hub link`。
   */
  const dir = makeDir({
    "index.html": "<h1>hi</h1>",
    "readme.md": "參考資料：https://example.com/",
  });

  try {
    assert.equal(detectLinkFolder(dir).isLink, false);
    assert.notEqual(detectProject(dir).kind, "link");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectProject 把只有網址檔的資料夾判成 link", () => {
  const dir = makeDir({ "連結.txt": "https://example.com/" });

  try {
    assert.equal(detectProject(dir).kind, "link");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空資料夾仍然是 unknown，不是 link", () => {
  const dir = makeDir({ "說明.txt": "這裡沒有網址" });

  try {
    assert.equal(detectProject(dir).kind, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("建置計畫把 link 擋下來，並指向正確的指令", () => {
  const dir = makeDir({ "連結.txt": "https://example.com/" });

  try {
    const plan = planBuild(dir);

    assert.equal(plan.kind, "link");
    assert.equal(plan.blockers.length, 1);
    assert.match(plan.blockers[0], /hub\.mjs link/);
    // 當成 note 放行的話，ship 會一路走到「找不到要上傳的檔案」才失敗，
    // 訊息完全看不出真正的原因。
    assert.equal(plan.command, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 網頁建議值 ──────────────────────────────────────────────

test("parsePageMeta 取得標題與說明，og: 優先於 <title>", () => {
  const html = "<html><head><title>備援標題</title>"
    + "<meta property=\"og:title\" content=\"甲班 &amp; 乙班\">"
    + "<meta name=\"description\" content=\"一句話說明\">"
    + "</head><body></body></html>";

  const meta = parsePageMeta(html);

  assert.equal(meta.name, "甲班 & 乙班");
  assert.equal(meta.description, "一句話說明");
});

test("parsePageMeta 在什麼都沒有時回 null，不回空字串", () => {
  // 空字串會讓呼叫端的 `?? folderName` 備援失效，建議值變成空白。
  const meta = parsePageMeta("<html><head><title>   </title></head></html>");

  assert.equal(meta.name, null);
  assert.equal(meta.description, null);
});

test("fetchPageMeta 抓不到網頁時不丟例外", async () => {
  const failing = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };

  const result = await fetchPageMeta("https://example.invalid/", { fetchFn: failing });

  assert.equal(result.ok, false);
  assert.equal(result.name, null);
  assert.match(result.error, /ENOTFOUND/);
});

test("suggestSlugFromUrl 取主機名稱的第一段", () => {
  assert.equal(suggestSlugFromUrl("https://my-class.pages.dev/x"), "my-class");
  assert.equal(suggestSlugFromUrl("https://www.my-class.pages.dev/x"), "my-class");
  // 中文資料夾名推不出 slug（suggestSlug 刻意不做音譯），此時回 null 讓
  // 呼叫端要求使用者自己輸入，而不是塞一個看不懂的值進網址。
  assert.equal(suggestSlugFromUrl("https://例子.tw/", "我的班網"), null);
});

// ── 登錄流程 ────────────────────────────────────────────────

/**
 * @param {{ dir: string, answers?: string[], approve?: boolean, existing?: any }} setup
 */
function runLink(setup) {
  const answers = [...(setup.answers ?? [])];
  /** @type {any[]} */
  const registered = [];
  /** @type {any[]} */
  const thumbnails = [];

  return linkProject({
    dir: setup.dir,
    prompt: async () => answers.shift() ?? "",
    confirm: async () => setup.approve !== false,
    now: "2026-08-30T00:00:00.000Z",
    fetchFn: async () => {
      throw new Error("測試不連網");
    },
    getProjectFn: async () => setup.existing ?? null,
    register: async (fields) => {
      registered.push(fields);
      return { projectId: 42, visibility: "private", isNew: setup.existing == null };
    },
    storeThumbnail: async (input) => {
      thumbnails.push(input);
      return { thumbnailUrl: "/media/thumbnails/x.png", chunkCount: 1, byteSize: 10, contentType: "image/png" };
    },
  }).then((result) => ({ result, registered, thumbnails }));
}

test("登錄一個外部連結專案：平台 external、權限 private", async () => {
  const dir = makeDir({ "連結.txt": "https://my-class.pages.dev/" });

  try {
    const { result, registered } = await runLink({ dir, answers: ["我的班網", "my-class", "說明"] });

    assert.equal(result.ok, true);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].platform, "external");
    /*
     * **不可以是 "other"**：`public/app.js` 看到 "other" 就會在卡片上標
     * 「需下載安裝」，tooltip 說「這不是可直接在瀏覽器開啟的網站」——
     * 對一個外部網頁而言那是錯的。本機實測時真的印出了那個標籤。
     */
    assert.equal(registered[0].project_type, "static");
    assert.equal(registered[0].deployment_url, "https://my-class.pages.dev/");
    // 新專案一律 private 是刻意的安全預設（register.mjs 的丙方案）。
    assert.equal(registered[0].visibility, "private");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("代稱撞到既有專案時，不清掉它的 GitHub 網址與 Worker 名稱", async () => {
  /*
   * `buildUpsertProjectSql()` 的 UPDATE 分支是**無條件覆寫** repository_url
   * 與 worker_name 的：呼叫端沒給值就寫成 NULL。`hub ship` 每次都帶著它們
   * 所以看不出問題，但 link 手上根本沒有這兩個值。不帶回去的話，
   * 對一個曾經 ship 過的代稱跑 link，會靜默清掉那兩欄。
   */
  const dir = makeDir({ "連結.txt": "https://my-class.pages.dev/" });

  try {
    const existing = {
      id: 7,
      platform: "cloudflare",
      deployment_url: "https://old.workers.dev/",
      repository_url: "https://github.com/someone/repo",
      worker_name: "my-class",
    };

    const { registered } = await runLink({ dir, answers: ["我的班網", "my-class", ""], existing });

    assert.equal(registered[0].repository_url, "https://github.com/someone/repo");
    assert.equal(registered[0].worker_name, "my-class");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("使用者拒絕確認時，完全不寫入", async () => {
  const dir = makeDir({ "連結.txt": "https://my-class.pages.dev/" });

  try {
    const { result, registered, thumbnails } = await runLink({
      dir,
      answers: ["我的班網", "my-class", ""],
      approve: false,
    });

    assert.equal(result.ok, false);
    assert.equal(registered.length, 0);
    assert.equal(thumbnails.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("資料夾裡沒有網址檔時停下來，並說明怎麼補", async () => {
  const dir = makeDir({ "說明.txt": "這裡沒有網址" });

  try {
    const { result, registered } = await runLink({ dir });

    assert.equal(result.ok, false);
    assert.equal(registered.length, 0);
    assert.equal(result.steps[0].status, "stopped");
    assert.match(result.steps[0].detail, /找不到寫著網址的文字檔/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("資料夾裡有網頁時停下來，並指向 hub ship", async () => {
  const dir = makeDir({ "index.html": "<h1>hi</h1>", "連結.txt": "https://example.com/" });

  try {
    const { result, registered } = await runLink({ dir });

    assert.equal(result.ok, false);
    assert.equal(registered.length, 0);
    assert.match(result.steps[0].detail, /hub\.mjs ship/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("代稱格式不合時停下來，且沒有寫入任何資料", async () => {
  const dir = makeDir({ "連結.txt": "https://例子.tw/" });

  try {
    // 主機名推不出 slug，使用者又一直輸入不合格的值 → 應該停，不能無限重問。
    const { result, registered } = await runLink({
      dir,
      answers: ["我的班網", "大寫Slug", "大寫Slug", "大寫Slug", "大寫Slug", "大寫Slug"],
    });

    assert.equal(result.ok, false);
    assert.equal(registered.length, 0);
    assert.match(result.steps.at(-1).detail, /還沒有寫入任何資料/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("有圖片時接上縮圖上傳；沒有時給補救指令而不是靜默跳過", async () => {
  const withImage = makeDir({ "連結.txt": "https://my-class.pages.dev/" });
  const withoutImage = makeDir({ "連結.txt": "https://my-class.pages.dev/" });

  try {
    writeFileSync(join(withImage, "截圖.png"), Buffer.from([137, 80, 78, 71]));

    const a = await runLink({ dir: withImage, answers: ["班網", "my-class", ""] });

    assert.equal(a.thumbnails.length, 1);
    assert.equal(a.thumbnails[0].projectId, 42);

    const b = await runLink({ dir: withoutImage, answers: ["班網", "my-class", ""] });

    assert.equal(b.thumbnails.length, 0);
    assert.equal(b.result.ok, true);

    const step = b.result.steps.find((item) => item.step === "thumbnail");

    assert.equal(step.status, "warn");
    assert.match(step.detail, /hub\.mjs thumbnail/);
  } finally {
    rmSync(withImage, { recursive: true, force: true });
    rmSync(withoutImage, { recursive: true, force: true });
  }
});

test("http:// 會被登錄，但要留下一則提醒", async () => {
  const dir = makeDir({ "連結.txt": "http://my-class.example.com/" });

  try {
    const { result, registered } = await runLink({ dir, answers: ["班網", "my-class", ""] });

    assert.equal(result.ok, true);
    assert.equal(registered[0].deployment_url, "http://my-class.example.com/");

    const warned = result.steps.some(
      (step) => step.status === "warn" && step.detail.includes("http://"),
    );

    assert.ok(warned, "http:// 的網址應該留下一則不加密的提醒");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
