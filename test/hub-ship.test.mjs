import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { injectGate } from "../tools/inject-gate.mjs";
import { readInjectedVisibility } from "../tools/inject-gate.mjs";
import { buildPasswordHashSql, readPasswordHash } from "../tools/policy-secret.mjs";
import { parseDeployedUrl, shipProject } from "../tools/ship.mjs";

const ALWAYS_YES = async () => true;

// ── parseDeployedUrl：純函式 ──

test("parseDeployedUrl extracts the URL from real wrangler deploy output", () => {
  const stdout = "Deployed resistor-quiz triggers (1.2 sec)\n  https://resistor-quiz.example.workers.dev\n";

  assert.equal(parseDeployedUrl(stdout), "https://resistor-quiz.example.workers.dev");
});

test("parseDeployedUrl returns null when no workers.dev URL is present", () => {
  assert.equal(parseDeployedUrl("No targets deployed for resistor-quiz (0.3 sec)\n"), null);
});

test("parseDeployedUrl ignores unrelated https lines and only matches workers.dev", () => {
  const stdout = "Uploaded resistor-quiz (2.1 sec)\nSee https://dash.cloudflare.com/some/path for details\n  https://resistor-quiz.example.workers.dev\n";

  assert.equal(parseDeployedUrl(stdout), "https://resistor-quiz.example.workers.dev");
});

// ── shipProject：全流程整合，全部透過假的注入點 ──

/**
 * @param {{ withSecret?: boolean }} [options]
 * @returns {string}
 */
function makeProject(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-ship-"));

  writeFileSync(join(dir, "project-hub.json"), JSON.stringify({ name: "測試專案", slug: "ship-test" }));
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>t</title>\n");
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    `{
	"name": "ship-test",
	"compatibility_date": "2026-08-08",
	"assets": {
		"directory": "./public/"
	}
}
`,
  );

  if (options.withSecret) {
    writeFileSync(join(dir, "config.js"), `export const key = "AKIA${"TESTKEY0EXAMPLE1"}";\n`);
  }

  return dir;
}

/**
 * 建一個「閘道注入成功、但接下來的 `wrangler deploy` 失敗」之後重試會看到
 * 的目錄——用真正的 `injectGate()` 產生 main／access-gate 痕跡，確保測的是
 * `isOwnGateAlreadyInjected()` 真的會辨認出的格式，不是憑空模擬的簡化版。
 *
 * @returns {string}
 */
function makeContinuationProject() {
  const dir = makeProject();

  injectGate(dir, { projectId: 42, visibility: "private", policyVersion: 1, projectName: "測試專案" });

  return dir;
}

/**
 * 包一層 runCommand，攔截 `wrangler deploy` 的 `--secrets-file` 參數，趁
 * 檔案還沒被 `ship.mjs` 的 finally 區塊刪除前讀出內容——測試跑完再讀就晚了。
 *
 * @param {(command: string, args: string[], cwd?: string) => Promise<any>} baseRunner
 * @param {{ content?: string }} capture
 */
function captureSecretsFile(baseRunner, capture) {
  return async function (command, args, cwd) {
    const flagIndex = args.indexOf("--secrets-file");

    if (flagIndex !== -1) {
      capture.content = readFileSync(args[flagIndex + 1], "utf8");
    }

    return baseRunner(command, args, cwd);
  };
}

/**
 * 涵蓋 `publishToGithub`（見 `test/hub-github.test.mjs`）需要的每一種呼叫，
 * 再加上 `hub ship` 自己額外的：閘道 commit／push、`wrangler deploy`、
 * `git rev-parse HEAD`。
 *
 * @param {Record<string, any>} config
 * @param {string[][]} calls
 */
function makeFakeRunner(config, calls) {
  let pushCount = 0;

  return async function fakeRun(command, args) {
    calls.push([command, ...args]);

    if (command === "gh" && args[0] === "--version") {
      return { code: 0, stdout: "gh version 2.0.0", stderr: "" };
    }

    if (command === "gh" && args[0] === "auth" && args[1] === "status") {
      return {
        code: 0,
        stdout: `github.com\n  ✓ Logged in to github.com account ${config.activeAccount ?? "ncueyu"} (keyring)\n  - Active account: true\n`,
        stderr: "",
      };
    }

    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      if (config.remoteUrl == null) {
        return { code: 1, stdout: "", stderr: "fatal: no such remote 'origin'" };
      }

      return { code: 0, stdout: `${config.remoteUrl}\n`, stderr: "" };
    }

    if (command === "gh" && args[0] === "repo" && args[1] === "view" && args.length === 3) {
      return config.remoteRepoExists
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "not found" };
    }

    if (command === "git" && args[0] === "init") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "add") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "status" && args[1] === "--porcelain") {
      return { code: 0, stdout: " M index.html\n", stderr: "" };
    }

    if (command === "git" && args[0] === "commit") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "gh" && args[0] === "repo" && args[1] === "create") {
      // 新專案的第一次推送就是這個指令本身（gh repo create ... --push），
      // 不是後面的 git push——pushOk 也該影響它，否則測「推送失敗」時
      // 這個分支永遠成功，測試等於沒測到東西。
      return config.pushOk === false ? { code: 1, stdout: "", stderr: "rejected" } : { code: 0, stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "remote" && args[1] === "add") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "push") {
      pushCount += 1;

      return config.pushOk === false ? { code: 1, stdout: "", stderr: "rejected" } : { code: 0, stdout: "", stderr: "" };
    }

    if (command === "gh" && args[0] === "repo" && args[1] === "view" && args.includes("--json")) {
      return {
        code: 0,
        stdout: JSON.stringify({ visibility: "PRIVATE", name: "ship-test" }),
        stderr: "",
      };
    }

    if (command === "git" && args[0] === "rev-parse") {
      return { code: 0, stdout: "abc123def456\n", stderr: "" };
    }

    if (args.includes("deploy")) {
      // command 必須是 process.execPath（node 本身），wrangler.js 的路徑要在
      // args 陣列裡當第一個參數，不能把 wrangler.js 的路徑直接當 command——
      // 2026-08-26 真部署測試才發現這裡曾經寫錯，在 Windows 上會得到
      // EFTYPE（.js 不是可直接執行的程式）。假的 runCommand 不會替你檢查
      // command 是不是真的可執行，所以特別在這裡斷言呼叫慣例本身沒有錯，
      // 不只是斷言「有沒有呼叫」。
      assert.equal(command, process.execPath, "deploy 必須用 node 本身當 command，wrangler.js 路徑放在 args 裡");
      assert.equal(args[0].endsWith("wrangler.js") || args[0].endsWith("wrangler"), true, "args[0] 應該是 wrangler 執行檔路徑");


      if (config.deployOk === false) {
        return { code: 1, stdout: "", stderr: "deploy failed" };
      }

      const stdout = config.deployStdout ?? "Deployed ship-test triggers (1.0 sec)\n  https://ship-test.example.workers.dev\n";

      return { code: 0, stdout, stderr: "" };
    }

    throw new Error(`測試沒有預期到這個呼叫：${command} ${args.join(" ")}`);
  };
}

/** 假的雜湊字串。形狀模仿真的，但完全是編的。 */
const FAKE_HASH = "pbkdf2$10000$ZmFrZXNhbHQ$ZmFrZWhhc2h2YWx1ZQ";

function makeShipOptions(overrides = {}) {
  const calls = [];
  const runnerConfig = {
    activeAccount: "ncueyu",
    remoteRepoExists: false,
    deployOk: true,
    ...overrides.runnerConfig,
  };

  return {
    calls,
    options: {
      confirm: overrides.confirm ?? ALWAYS_YES,
      runCommand: makeFakeRunner(runnerConfig, calls),
      ensureProjectRegistered: overrides.ensureProjectRegistered,
      registerDeployment: overrides.registerDeployment,
      readPasswordHash: overrides.readPasswordHash,
      fetch: overrides.fetch,
    },
  };
}

test("a project whose GitHub push fails stops before touching the database or deploying", async () => {
  const { calls, options } = makeShipOptions({ runnerConfig: { pushOk: false } });
  let ensureCalled = false;

  options.ensureProjectRegistered = async () => {
    ensureCalled = true;
    return { projectId: 1, visibility: "private", isNew: true };
  };

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, false);
  assert.equal(ensureCalled, false, "GitHub 推送沒成功就不該去動資料庫");
  assert.equal(calls.some((c) => c[0] === "deploy" || c.includes("deploy")), false);
});

test("a blocked secret stops the whole ship, never reaching deploy or the database", async () => {
  const { calls, options } = makeShipOptions();
  let ensureCalled = false;

  options.ensureProjectRegistered = async () => {
    ensureCalled = true;
    return { projectId: 1, visibility: "private", isNew: true };
  };

  const result = await shipProject(makeProject({ withSecret: true }), options);

  assert.equal(result.ok, false);
  assert.equal(ensureCalled, false);
  assert.equal(calls.some((c) => c.includes("deploy")), false);
});

test("a new static project is registered private, gets a gate, and deploys with a secrets file", async () => {
  const { calls, options } = makeShipOptions();

  options.ensureProjectRegistered = async (fields) => {
    assert.equal(fields.slug, "ship-test");
    return { projectId: 42, visibility: "private", isNew: true };
  };

  let registeredWith = null;

  options.registerDeployment = async (fields) => {
    registeredWith = fields;
    return { projectId: 42, visibility: "private", isNew: false };
  };

  options.fetch = async (url) => {
    assert.equal(url, "https://ship-test.example.workers.dev");
    return new Response("Not found", { status: 404 });
  };

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));
  assert.equal(result.deploymentUrl, "https://ship-test.example.workers.dev");
  assert.equal(result.visibility, "private");

  // 閘道注入確實發生：多了一次 commit 與一次 push（推程式碼那次 ＋ 推閘道那次）。
  const commitCalls = calls.filter((c) => c[0] === "git" && c[1] === "commit");
  // 新專案的第一次推送是靠 `gh repo create ... --push` 完成的，不是
  // 額外一次 `git push`——所以這裡只斷言「閘道那次額外的 git push 確實發生」，
  // 不假設兩次推送用的是同一種指令。
  const gatePushCalls = calls.filter((c) => c[0] === "git" && c[1] === "push");

  assert.ok(commitCalls.length >= 2, "應該有兩次 commit：程式碼本身與閘道");
  assert.equal(gatePushCalls.length, 1, "閘道注入後應該額外推送一次");

  // 部署帶了 --secrets-file。
  const deployCall = calls.find((c) => c.includes("deploy"));

  assert.ok(deployCall.includes("--secrets-file"), "私人專案部署時必須帶簽章金鑰");

  assert.equal(registeredWith.deployment_url, "https://ship-test.example.workers.dev");
  assert.equal(registeredWith.version_ref, "abc123def456");
});

test("an existing public project is not gated, and deploys without a secrets file", async () => {
  const { calls, options } = makeShipOptions();

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "public", isNew: false });
  options.registerDeployment = async () => ({ projectId: 7, visibility: "public", isNew: false });
  options.fetch = async () => new Response("OK", { status: 200 });

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));
  assert.equal(result.visibility, "public");

  const injectStep = result.steps.find((s) => s.step === "inject-gate");

  assert.equal(injectStep.status, "skipped");

  const commitCalls = calls.filter((c) => c[0] === "git" && c[1] === "commit");

  assert.equal(commitCalls.length, 1, "public 專案不需要第二個 commit");

  const deployCall = calls.find((c) => c.includes("deploy"));

  assert.equal(deployCall.includes("--secrets-file"), false);
});

// ── 縮圖（2026-08-30 接上，同日改存 D1）──────────────────────────
//
// 兩個缺口的護欄：
//
//   ① installThumbnail() 從 2026-08-17 就寫好了，但**從來沒有任何地方呼叫它**，
//      而 AGENTS.md 第 8 節卻寫著「hub ship 部署時會自動搬走」。使用者把截圖
//      放進資料夾不會有任何事發生，也不會有錯誤訊息。
//
//   ② 接上之後才發現舊做法（複製成 public/thumbnails/ 的靜態檔）會**靜默蓋掉
//      使用者在後台選的圖**：thumbnail_url 交給 registerDeployment()，只要資料夾
//      裡有任何圖片就覆蓋。改成存 D1 並由 storeThumbnailFromFile() 自己更新。

test("專案資料夾裡的截圖會被存進 D1 並指給這個專案", async () => {
  const { options } = makeShipOptions();
  const projectDir = makeProject();

  writeFileSync(join(projectDir, "我的網站截圖.png"), "fake-png-bytes");

  let registeredFields = null;
  let stored = null;

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "public", isNew: false });
  options.registerDeployment = async (fields) => {
    registeredFields = fields;
    return { projectId: 7, visibility: "public", isNew: false };
  };
  options.getProject = async () => ({ id: 7, thumbnail_url: "/media/thumbnails/old.png" });
  options.storeThumbnail = async (input) => {
    stored = input;
    return { thumbnailUrl: "/media/thumbnails/new.png", chunkCount: 1, byteSize: 14, contentType: "image/png" };
  };
  options.fetch = async () => new Response("OK", { status: 200 });

  const result = await shipProject(projectDir, options);

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));

  assert.ok(stored, "應該呼叫 storeThumbnailFromFile()");
  assert.match(stored.imagePath, /我的網站截圖\.png$/);
  // projectId 要用登錄回來的真實 id，不能是別的東西。
  assert.equal(stored.projectId, 7);
  // 舊圖的位元組要被清掉，否則每次重新部署都留下一份孤兒吃掉 D1 配額。
  assert.equal(stored.previousThumbnailUrl, "/media/thumbnails/old.png");

  /*
   * **registerDeployment 不可以再收到 thumbnail_url。** 兩處寫同一欄日後一定會
   * 不一致，而且那正是舊做法蓋掉使用者後台選圖的來源。
   */
  assert.equal(registeredFields.thumbnail_url, undefined);

  const step = result.steps.find((s) => s.step === "thumbnail");

  assert.equal(step.status, "ok");
  // 存 D1 是即時生效的，**不可以**再叫使用者重新部署展示中心——
  // 叫人做一件不需要做的事，下次他就不會相信講的時序了。
  assert.equal(/npm run deploy/.test(step.detail), false);
  assert.match(step.detail, /不需要重新部署/);
});

test("縮圖存檔失敗只記 warn，不讓已經成功的部署變成失敗", async () => {
  const { options } = makeShipOptions();
  const projectDir = makeProject();

  writeFileSync(join(projectDir, "截圖.png"), "fake-png-bytes");

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "public", isNew: false });
  options.registerDeployment = async () => ({ projectId: 7, visibility: "public", isNew: false });
  options.getProject = async () => ({ id: 7, thumbnail_url: null });
  options.storeThumbnail = async () => {
    throw new Error("這張圖 3.2 MB，超過 1 MB 的上限。");
  };
  options.fetch = async () => new Response("OK", { status: 200 });

  const result = await shipProject(projectDir, options);

  // 網站已經上線了，為了一張卡片上的圖把整次部署標成失敗是不成比例的。
  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));

  const step = result.steps.find((s) => s.step === "thumbnail");

  assert.equal(step.status, "warn");
  assert.match(step.detail, /超過 1 MB/);
});

test("查不到既有專案時仍然存得進去，只是跳過孤兒清理", async () => {
  const { options } = makeShipOptions();
  const projectDir = makeProject();

  writeFileSync(join(projectDir, "截圖.png"), "fake-png-bytes");

  let stored = null;

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "public", isNew: true });
  options.registerDeployment = async () => ({ projectId: 7, visibility: "public", isNew: true });
  options.getProject = async () => {
    throw new Error("D1 連不上");
  };
  options.storeThumbnail = async (input) => {
    stored = input;
    return { thumbnailUrl: "/media/thumbnails/x.png", chunkCount: 1, byteSize: 14, contentType: "image/png" };
  };
  options.fetch = async () => new Response("OK", { status: 200 });

  const result = await shipProject(projectDir, options);

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));
  assert.equal(stored.previousThumbnailUrl, null);
  assert.equal(result.steps.find((s) => s.step === "thumbnail").status, "ok");
});

test("沒有截圖時不產生縮圖步驟，也完全不碰 thumbnail_url（不覆蓋後台設好的圖）", async () => {
  const { options } = makeShipOptions();

  let registeredFields = null;
  let storeCalls = 0;

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "public", isNew: false });
  options.registerDeployment = async (fields) => {
    registeredFields = fields;
    return { projectId: 7, visibility: "public", isNew: false };
  };
  options.storeThumbnail = async () => {
    storeCalls += 1;
    return { thumbnailUrl: "", chunkCount: 0, byteSize: 0, contentType: "image/png" };
  };
  options.fetch = async () => new Response("OK", { status: 200 });

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, true);
  assert.equal(result.steps.some((s) => s.step === "thumbnail"), false);
  assert.equal(storeCalls, 0);
  assert.equal(registeredFields.thumbnail_url, undefined);
});

test("password 專案會注入閘道並完成部署（2026-08-29 起支援，原本是擋停）", async () => {
  /*
   * 這條測試原本斷言 password 專案會被擋停（step: "gate-scope-check"）——
   * 那是「密碼雜湊轉成目標專案 Secret」還沒做出來之前的權宜行為。
   * 順位 7 把那一段補上了，所以正確行為從「擋停」變成「注入密碼並部署」。
   *
   * 沒有刪掉這條測試，是因為它原本盯的風險仍然存在且更重要了：
   * password 專案**不能被靜默誤處理**。斷言改成新的正確行為，
   * 並保留「閘道要真的被注入」這一項——沒有閘道的 password 專案就是沒有保護。
   */
  const { calls, options } = makeShipOptions();

  options.ensureProjectRegistered = async () => ({ projectId: 9, visibility: "password", isNew: false });
  options.registerDeployment = async () => ({ deploymentId: 1 });
  options.fetch = async () => new Response("", { status: 404 });
  options.readPasswordHash = async () => FAKE_HASH;

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.includes("deploy")), "應該真的部署");

  const gateStep = result.steps.find((step) => step.step === "inject-gate");
  assert.equal(gateStep?.status, "ok", "password 專案沒有閘道就等於沒有保護");
});

test("a worker-type project (already has its own main) is refused before any DB write", async () => {
  const dir = makeProject();

  writeFileSync(
    join(dir, "wrangler.jsonc"),
    `{
	"name": "ship-test",
	"main": "src/index.js",
	"compatibility_date": "2026-08-08"
}
`,
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.js"), "export default { fetch() { return new Response('ok'); } };\n");

  const { options } = makeShipOptions();
  let ensureCalled = false;

  options.ensureProjectRegistered = async () => {
    ensureCalled = true;
    return { projectId: 1, visibility: "private", isNew: true };
  };

  const result = await shipProject(dir, options);

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "scope-check");
  assert.equal(ensureCalled, false, "型態不符時不該去動資料庫");
});

test("a deploy failure reports that the code is already safely pushed and can be retried", async () => {
  const { options } = makeShipOptions({ runnerConfig: { deployOk: false } });

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "public", isNew: false });
  options.registerDeployment = async () => {
    throw new Error("不該在部署失敗後還去登錄資料庫");
  };

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, false);
  assert.match(result.steps.at(-1).detail, /已經推上 GitHub.*安全重試/);
});

test("a successful deploy whose output has no parseable URL stops rather than assuming success", async () => {
  const { options } = makeShipOptions({ runnerConfig: { deployStdout: "No targets deployed for ship-test (0.1 sec)\n" } });

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "public", isNew: false });
  options.registerDeployment = async () => {
    throw new Error("不該在網址不明的情況下還去登錄資料庫");
  };

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, false);
  assert.match(result.steps.at(-1).detail, /不確定真正的部署狀態/);
});

test("a mismatched verification status code is reported, not silently accepted as done", async () => {
  const { options } = makeShipOptions();

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "private", isNew: false });
  options.registerDeployment = async () => ({ projectId: 7, visibility: "private", isNew: false });
  // private 專案應該是 404，這裡故意回 200，模擬「其實還是被公開了」的情境。
  options.fetch = async () => new Response("SITE CONTENT", { status: 200 });

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "verify");
  assert.match(result.steps.at(-1).detail, /200.*404|預期 404/);
});

test("a directory left gated by a previous failed deploy is treated as a continuation, not refused as someone else's Worker project", async () => {
  const dir = makeContinuationProject();
  const { calls, options } = makeShipOptions();
  const secretsCapture = {};

  options.runCommand = captureSecretsFile(options.runCommand, secretsCapture);

  options.ensureProjectRegistered = async (fields) => {
    assert.equal(fields.project_type, "static", "本質上是靜態專案，即便 wrangler.jsonc 目前有 main 也不該記成 worker");
    return { projectId: 42, visibility: "private", isNew: false };
  };

  let registeredWith = null;

  options.registerDeployment = async (fields) => {
    registeredWith = fields;
    return { projectId: 42, visibility: "private", isNew: false };
  };

  options.fetch = async () => new Response("Not found", { status: 404 });

  const result = await shipProject(dir, options);

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));

  const scopeCheckStep = result.steps.find((s) => s.step === "scope-check");

  assert.equal(scopeCheckStep.status, "ok", "不該在 scope-check 被拒絕");

  const injectStep = result.steps.find((s) => s.step === "inject-gate");

  assert.equal(injectStep.status, "skipped", "偵測到自己上次的痕跡，不該重新呼叫 injectGate()");

  // 不該重複 commit：只有程式碼推送本身那一次 commit，沒有第二次閘道 commit／push。
  const commitCalls = calls.filter((c) => c[0] === "git" && c[1] === "commit");
  const gatePushCalls = calls.filter((c) => c[0] === "git" && c[1] === "push");

  assert.equal(commitCalls.length, 1, "已經注入過，不該再 commit 一次閘道設定");
  assert.equal(gatePushCalls.length, 0, "已經注入過，不該再多推送一次");

  assert.equal(registeredWith.project_type, "static");

  assert.ok(secretsCapture.content, "部署應該帶了簽章金鑰檔案");
  assert.match(
    secretsCapture.content,
    /^SESSION_SIGNING_KEY=[0-9a-f]{64}\n$/,
    "應該是新產生的隨機十六進位金鑰，不是空的或固定假值",
  );
});

/* ==========================================================================
 * password 專案的密碼雜湊注入（2026-08-29，缺口盤點順位 7）
 *
 * 這一組測試的重心不是「功能會動」，而是**兩件會造成實質傷害的事**：
 *   1. 雜湊外流到任何看得到的地方（步驟訊息、--json、錯誤訊息）。
 *      雜湊出現在終端機輸出，就等於出現在使用者與 AI 的對話裡。
 *   2. 權限宣稱有密碼、實際上沒有保護就部署出去。
 * ========================================================================== */

function makePasswordProjectOptions(overrides = {}) {
  const { calls, options } = makeShipOptions(overrides);

  options.ensureProjectRegistered = async () => ({ projectId: 7, visibility: "password", isNew: false });
  options.registerDeployment = async () => ({ deploymentId: 1 });
  options.fetch = async () => new Response("", { status: 404 });

  return { calls, options };
}

test("password 專案會把密碼雜湊隨部署注入成 PROJECT_PASSWORD_HASH", async () => {
  const capture = {};
  const { options } = makePasswordProjectOptions();

  options.readPasswordHash = async () => FAKE_HASH;
  options.runCommand = captureSecretsFile(options.runCommand, capture);

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, true, "password 專案不該再被擋停");
  assert.ok(capture.content, "應該有帶 --secrets-file");
  assert.match(capture.content, /^PROJECT_PASSWORD_HASH=/m);
  assert.match(capture.content, /^SESSION_SIGNING_KEY=/m, "閘道也需要簽章金鑰");
});

test("密碼雜湊【絕不】出現在任何輸出裡", async () => {
  /*
   * 本組最重要的一條。tools/queries.mjs 的檔頭寫著它完全不查 project_policies，
   * 理由是「MCP 工具的輸出會直接進入 AI 的脈絡」。這個功能開了一條讀取雜湊的
   * 管道，就必須證明那條管道是單向的——只流向 --secrets-file，不流向任何
   * 人或 AI 看得到的地方。
   */
  const { options } = makePasswordProjectOptions();
  options.readPasswordHash = async () => FAKE_HASH;

  const result = await shipProject(makeProject(), options);

  const everythingVisible = JSON.stringify(result);
  assert.equal(
    everythingVisible.includes(FAKE_HASH),
    false,
    "雜湊出現在回傳結果裡——那會被印進終端機，等於出現在對話中",
  );

  // 連片段都不行：擷取一段也足以縮小暴力破解的範圍。
  assert.equal(everythingVisible.includes(FAKE_HASH.slice(0, 20)), false, "雜湊的片段也不能外流");
});

test("權限是密碼但還沒設定密碼時停下，不部署出一個假裝有保護的網站", async () => {
  /*
   * 後台允許先改權限、之後才輸入密碼，所以這是真實會出現的中間狀態。
   * 照樣部署會做出一個宣稱受保護、實際上誰都打得開的網站，而使用者以為它鎖著——
   * 「以為有保護但其實沒有」是最危險的那一類失敗，不能只給警告。
   */
  const { calls, options } = makePasswordProjectOptions();
  options.readPasswordHash = async () => null;

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, false);
  assert.match(result.steps.at(-1).detail, /還沒有設定密碼/);
  assert.equal(
    calls.some((call) => call.includes("deploy")),
    false,
    "沒有密碼就不該部署",
  );
});

test("讀取密碼失敗時停下並說明，不當成沒有密碼", async () => {
  // 讀取失敗（網路、權限、資料庫問題）若被當成 null，就會走進「沒設定密碼」
  // 那條路——但真相可能是密碼存在、只是這次讀不到。兩者必須分開。
  const { calls, options } = makePasswordProjectOptions();
  options.readPasswordHash = async () => { throw new Error("D1 連不上"); };

  const result = await shipProject(makeProject(), options);

  assert.equal(result.ok, false);
  assert.match(result.steps.at(-1).detail, /讀取密碼設定失敗/);
  assert.equal(calls.some((call) => call.includes("deploy")), false);
});

test("非 password 專案不會去讀密碼，也不會帶 PROJECT_PASSWORD_HASH", async () => {
  const capture = {};
  const { options } = makeShipOptions();
  let readCalled = false;

  options.ensureProjectRegistered = async () => ({ projectId: 3, visibility: "private", isNew: false });
  options.registerDeployment = async () => ({ deploymentId: 1 });
  options.fetch = async () => new Response("", { status: 404 });
  options.readPasswordHash = async () => { readCalled = true; return FAKE_HASH; };
  options.runCommand = captureSecretsFile(options.runCommand, capture);

  await shipProject(makeProject(), options);

  assert.equal(readCalled, false, "用不到就不要去碰那張表——少一次讀取就少一次外流機會");
  assert.equal((capture.content ?? "").includes("PROJECT_PASSWORD_HASH"), false);
});

test("buildPasswordHashSql 只選一個欄位，且 projectId 經過驗證", () => {
  // 列名而不是 SELECT *——queries.mjs 檔頭的原則：讓「哪些欄位會被讀出來」
  // 是一眼可查的事實，而不是要追資料表結構才知道。
  const sql = buildPasswordHashSql(7);

  assert.match(sql, /SELECT password_hash FROM project_policies/);
  assert.doesNotMatch(sql, /SELECT \*/);
  assert.match(sql, /project_id = 7/);

  // projectId 未經驗證會讓 SQL 可被注入（wrangler d1 execute 不能用繫結參數）
  assert.throws(() => buildPasswordHashSql("7 OR 1=1"));
});

test("readPasswordHash 把空字串當成沒設定", async () => {
  // 空字串當雜湊會讓任何密碼都對不上，但更糟的是它會讓呼叫端以為有保護。
  const run = async () => [{ password_hash: "   " }];
  assert.equal(await readPasswordHash(7, { executeSql: run }), null);

  const runNull = async () => [{ password_hash: null }];
  assert.equal(await readPasswordHash(7, { executeSql: runNull }), null);

  const runReal = async () => [{ password_hash: "abc" }];
  assert.equal(await readPasswordHash(7, { executeSql: runReal }), "abc");
});

test("權限在兩次部署之間改變時，閘道進入點會被重新產生", async () => {
  /*
   * 2026-08-29 真實端到端測試抓到的 bug 的回歸測試。
   *
   * 專案第一次以 private 部署，之後在後台改成 password 再重新部署時，
   * ship 會走「已經注入過、不重複寫入」那條路，於是現場的 hub-gate-entry.js
   * 裡仍烙著 visibility: "private"——密碼雜湊確實注入了，但閘道不看它，
   * 訪客拿到 404 而不是密碼輸入頁。功能等於沒做出來，而且每一步都顯示成功。
   *
   * 單元測試原本涵蓋不到，因為它需要「先部署、改權限、再部署」這個順序。
   */
  const dir = makeProject();

  // 先以 private 注入一次，模擬上一次部署的狀態
  injectGate(dir, { projectId: 9, visibility: "private", policyVersion: 1, projectName: "t" });
  assert.equal(readInjectedVisibility(dir), "private");

  const { options } = makeShipOptions();
  options.ensureProjectRegistered = async () => ({ projectId: 9, visibility: "password", isNew: false });
  options.registerDeployment = async () => ({ deploymentId: 1 });
  options.fetch = async () => new Response("", { status: 404 });
  options.readPasswordHash = async () => FAKE_HASH;

  const result = await shipProject(dir, options);

  assert.equal(result.ok, true);
  assert.equal(
    readInjectedVisibility(dir),
    "password",
    "權限改了卻沒重寫進入點——閘道會繼續用舊權限的邏輯，密碼形同虛設",
  );

  const gateStep = result.steps.find((step) => step.step === "inject-gate");
  assert.equal(gateStep.status, "ok");
  assert.match(gateStep.detail, /權限已從 private 改為 password/);
});

test("權限沒變時維持原本的跳過行為，不做多餘的 commit", async () => {
  const dir = makeProject();
  injectGate(dir, { projectId: 9, visibility: "private", policyVersion: 1, projectName: "t" });

  const { options } = makeShipOptions();
  options.ensureProjectRegistered = async () => ({ projectId: 9, visibility: "private", isNew: false });
  options.registerDeployment = async () => ({ deploymentId: 1 });
  options.fetch = async () => new Response("", { status: 404 });

  const result = await shipProject(dir, options);

  const gateStep = result.steps.find((step) => step.step === "inject-gate");
  assert.equal(gateStep.status, "skipped");
});
