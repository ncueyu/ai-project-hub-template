import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanDeployables } from "../tools/deploy-scan.mjs";
import { measureOutput, runPreDeployChecks } from "../tools/predeploy.mjs";

const FAKE_AWS_KEY = `AKIA${"TESTKEY0EXAMPLE1"}`;

/** 檢查中執行建置與測試屬於階段 C 的實務流程；單元測試一律略過。 */
const NO_EXTERNAL = { runBuild: false, runTests: false, runTypecheck: false };

/**
 * 建一個最小的靜態專案。
 *
 * @param {{ withSecret?: boolean, withSourceMap?: boolean }} [options]
 * @returns {string}
 */
function makeProject(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-predeploy-"));

  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>\n");
  writeFileSync(join(dir, "app.js"), "export const ok = true;\n");

  if (options.withSecret) {
    writeFileSync(join(dir, "config.js"), `export const key = "${FAKE_AWS_KEY}";\n`);
  }

  if (options.withSourceMap) {
    writeFileSync(join(dir, "app.js.map"), '{"version":3}\n');
  }

  return dir;
}

test("a clean static project passes and is not blocked", async () => {
  const result = await runPreDeployChecks(makeProject(), NO_EXTERNAL);

  assert.equal(result.blocked, false);

  const secrets = result.checks.find((check) => check.id === "secrets");

  assert.equal(secrets.status, "pass");
  assert.equal(secrets.level, "critical");
});

test("a planted key blocks deployment and the message names the file and line", async () => {
  const result = await runPreDeployChecks(makeProject({ withSecret: true }), NO_EXTERNAL);

  assert.equal(result.blocked, true);

  const secrets = result.checks.find((check) => check.id === "secrets");

  assert.equal(secrets.status, "fail");
  assert.match(secrets.detail, /config\.js:1/);
  assert.ok(!secrets.detail.includes(FAKE_AWS_KEY), "報告本身不可再洩漏一次");
});

test("source maps in the output directory are a blocking problem", async () => {
  // 靜態專案的產物目錄就是專案本身，所以 .map 會直接被視為產物的一部分。
  const result = await runPreDeployChecks(makeProject({ withSourceMap: true }), NO_EXTERNAL);

  const sourceMap = result.checks.find((check) => check.id === "source-map");

  assert.equal(sourceMap.status, "fail");
  assert.equal(sourceMap.level, "critical");
  assert.equal(result.blocked, true);
});

test("a project whose kind cannot be determined is blocked at the plan stage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-predeploy-"));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "make" } }));

  const result = await runPreDeployChecks(dir, NO_EXTERNAL);
  const plan = result.checks.find((check) => check.id === "plan");

  assert.equal(plan.status, "fail");
  assert.equal(result.blocked, true);
});

test("skipped checks are reported as skipped rather than silently passing", async () => {
  const result = await runPreDeployChecks(makeProject(), NO_EXTERNAL);

  for (const id of ["typecheck", "tests", "build"]) {
    const check = result.checks.find((item) => item.id === id);

    assert.equal(check.status, "skip", `${id} 應標記為略過`);
    assert.ok(check.detail.length > 0, `${id} 應說明為何略過`);
  }
});

test("advisory checks never block on their own", async () => {
  const result = await runPreDeployChecks(makeProject(), NO_EXTERNAL);
  const advisory = result.checks.filter((check) => check.level === "advisory");

  assert.ok(advisory.length > 0);
  assert.equal(result.blocked, false);
});

test("a fake key inside a test file warns but does not block", async () => {
  const dir = makeProject();

  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "sample.test.mjs"), `const k = "${FAKE_AWS_KEY}";\n`);

  const result = await runPreDeployChecks(dir, NO_EXTERNAL);
  const critical = result.checks.find((check) => check.id === "secrets");
  const advisory = result.checks.find((check) => check.id === "secrets-test");

  assert.equal(critical.status, "pass");
  assert.equal(advisory.level, "advisory");
  assert.match(advisory.detail, /sample\.test\.mjs:1/);
  assert.equal(result.blocked, false, "測試檔的假憑證不該擋住部署");
});

test("measureOutput counts files, bytes and source maps", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-measure-"));

  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "a.js"), "12345");
  writeFileSync(join(dir, "nested", "b.js.map"), "123");

  const measured = measureOutput(dir);

  assert.equal(measured.count, 2);
  assert.equal(measured.bytes, 8);
  assert.equal(measured.sourceMaps.length, 1);
});

// ---------------------------------------------------------------- 兩個出口的判斷
//
// 一個專案有兩個出口，送出去的檔案範圍不一樣：
//   Cloudflare → 只送產物目錄裡的東西
//   GitHub     → 送所有沒被 .gitignore 擋掉的東西
//
// 2026-08-23 之前掃描器只看產物目錄，於是把「不在產物目錄」當成「不會被上傳」。
// 合成案例實測：根目錄一個沒被 ignore 的 .env 被降級為「這次不會上傳」，
// 而 git 會把它 commit 上去。以下測試把修正後的行為釘住。

/**
 * 建一個「產物在子目錄」的專案，根目錄放一個 .env。
 *
 * @returns {string}
 */
function makeProjectWithRootEnv() {
  const dir = mkdtempSync(join(tmpdir(), "hub-dualexit-"));

  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>t</title>\n");
  writeFileSync(join(dir, ".env"), "SUPABASE_SERVICE_ROLE_KEY=fake-value-for-test\n");

  return dir;
}

test("a root .env that git would commit is not downgraded", () => {
  const dir = makeProjectWithRootEnv();
  const result = scanDeployables(dir, { outputDir: "public", gitFiles: [".env"] });

  const blocked = result.blocking.find((item) => item.path === ".env");

  assert.ok(blocked, "會進版控的 .env 必須維持阻擋級，不能因為「不在產物目錄」而降級");
  assert.equal(blocked.inOutput, false);
  assert.equal(blocked.inGit, true);
  // 說明必須講清楚為什麼——否則使用者會困惑「不是說產物目錄外就不會上傳嗎」。
  assert.match(blocked.reason, /GitHub/);
  assert.equal(
    result.confirm.some((item) => item.path === ".env"),
    false,
    "不應同時出現在需確認清單裡",
  );
});

test("a root .env that git ignores is downgraded to confirm", () => {
  const dir = makeProjectWithRootEnv();
  // gitFiles 不含 .env，代表 .gitignore 已經擋住它。
  const result = scanDeployables(dir, {
    outputDir: "public",
    gitFiles: ["public/index.html"],
  });

  const confirmed = result.confirm.find((item) => item.path === ".env");

  assert.ok(confirmed, "確定不會進版控時應降級為需確認——否則需要 .env 的建置流程無法進行");
  assert.equal(confirmed.inGit, false);
  assert.equal(
    result.blocking.some((item) => item.path === ".env"),
    false,
  );
});

test("without version control info the downgrade still happens but says so", () => {
  const dir = makeProjectWithRootEnv();
  // 不傳 gitFiles：可能不是 git 專案，或呼叫方拿不到清單。
  const result = scanDeployables(dir, { outputDir: "public" });

  const confirmed = result.confirm.find((item) => item.path === ".env");

  assert.ok(confirmed, "沒有版控資訊時維持原本的降級行為，避免擋住正當流程");
  assert.equal(confirmed.inGit, null, "「不知道」必須與「確定不會」區分，不能混為 false");
  assert.match(
    confirmed.reason,
    /無法確認/,
    "必須誠實標示這次沒有檢查版控，不能讓使用者以為已經確認過",
  );
});

test("git paths with forward slashes match on every platform", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-dualexit-sep-"));

  mkdirSync(join(dir, "public"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>t</title>\n");
  writeFileSync(join(dir, "data", ".env"), "TOKEN=fake-value-for-test\n");

  // git 一律輸出正斜線；本模組在 Windows 上用反斜線。不正規化就會比對失敗。
  const result = scanDeployables(dir, { outputDir: "public", gitFiles: ["data/.env"] });
  const hit = [...result.blocking, ...result.confirm].find((item) => item.path.endsWith(".env"));

  assert.ok(hit);
  assert.equal(hit.inGit, true, "正斜線的 git 路徑必須能對應到平台分隔符的路徑");
});

test("items heading for both destinations are listed first", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-dualexit-sort-"));

  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>t</title>\n");

  // 兩個檔案都在產物目錄內（inOutput 相同），差別只在會不會進版控。
  //
  // 檔名刻意讓字母順序與風險順序**相反**：只看 inOutput 的舊排序會判定平手，
  // 然後退回字母序把 a- 排前面；正確的兩軸排序要把「兩個出口都會送出」的 z- 排前面。
  //
  // 這一點不是可有可無的講究——第一版測試用的兩個檔案在新舊規則下順序相同，
  // 所以把排序修正整條移除之後測試仍然全過（假通過）。
  // 反向測試就是為了抓這種東西：測試沒失敗，不代表它守住了什麼。
  writeFileSync(join(dir, "public", "a-只會公開.csv"), "學號,姓名\n1,測試\n");
  writeFileSync(join(dir, "public", "z-兩個出口.csv"), "學號,姓名\n2,測試\n");

  const result = scanDeployables(dir, {
    outputDir: "public",
    gitFiles: ["public/index.html", "public/z-兩個出口.csv"],
  });

  const paths = result.confirm.map((item) => item.path);

  assert.equal(paths.length, 2, `預期兩個需確認項目，實際：${paths.join("、")}`);
  assert.ok(
    paths[0].endsWith("z-兩個出口.csv"),
    `兩個出口都會送出的要排最前，實際順序：${paths.join(" → ")}`,
  );
  assert.equal(result.confirm[0].inGit, true);
  assert.equal(result.confirm[1].inGit, false);
});

