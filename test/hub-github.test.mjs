import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideRepoAction, parseActiveGhAccount, parseGithubRemoteUrl, publishToGithub } from "../tools/github.mjs";

const FAKE_AWS_KEY = `AKIA${"TESTKEY0EXAMPLE1"}`;

/**
 * 真實 `gh auth status` 的輸出：這台機器同時有 `ncueyu`（作用中）與
 * `gpge0805`（非作用中）兩個帳號登入，格式是逐帳號一個區塊。
 */
const TWO_ACCOUNT_STATUS = `github.com
  ✓ Logged in to github.com account ncueyu (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account gpge0805 (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
`;

test("parseActiveGhAccount finds the account marked active among several", () => {
  assert.equal(parseActiveGhAccount(TWO_ACCOUNT_STATUS), "ncueyu");
});

test("parseActiveGhAccount returns null when nobody is marked active", () => {
  const noneActive = TWO_ACCOUNT_STATUS.replace("Active account: true", "Active account: false");

  assert.equal(parseActiveGhAccount(noneActive), null);
});

test("parseActiveGhAccount returns null on unrecognisable output", () => {
  assert.equal(parseActiveGhAccount("you are not logged into any GitHub hosts"), null);
});

test("parseGithubRemoteUrl accepts https, https without .git, and both ssh forms", () => {
  assert.deepEqual(parseGithubRemoteUrl("https://github.com/ncueyu/resistor-quiz.git"), {
    owner: "ncueyu",
    repo: "resistor-quiz",
  });
  assert.deepEqual(parseGithubRemoteUrl("https://github.com/ncueyu/resistor-quiz"), {
    owner: "ncueyu",
    repo: "resistor-quiz",
  });
  assert.deepEqual(parseGithubRemoteUrl("git@github.com:ncueyu/resistor-quiz.git"), {
    owner: "ncueyu",
    repo: "resistor-quiz",
  });
  assert.deepEqual(parseGithubRemoteUrl("ssh://git@github.com/ncueyu/resistor-quiz.git"), {
    owner: "ncueyu",
    repo: "resistor-quiz",
  });
});

test("parseGithubRemoteUrl returns null for non-GitHub or malformed input", () => {
  assert.equal(parseGithubRemoteUrl("https://gitlab.com/ncueyu/resistor-quiz.git"), null);
  assert.equal(parseGithubRemoteUrl(""), null);
  assert.equal(parseGithubRemoteUrl(null), null);
  assert.equal(parseGithubRemoteUrl(undefined), null);
});

test("decideRepoAction: no remote, repo does not exist yet -> create", () => {
  const decision = decideRepoAction({
    remote: null,
    expectedAccount: "ncueyu",
    remoteRepoExists: false,
    slug: "resistor-quiz",
  });

  assert.equal(decision.type, "create");
  assert.match(decision.reason, /ncueyu\/resistor-quiz/);
});

test("decideRepoAction: no remote, but a same-named repo already exists -> confirm-link", () => {
  const decision = decideRepoAction({
    remote: null,
    expectedAccount: "ncueyu",
    remoteRepoExists: true,
    slug: "resistor-quiz",
  });

  assert.equal(decision.type, "confirm-link");
  assert.match(decision.reason, /撞名/);
});

test("decideRepoAction: remote points to a different account -> stop, not auto-fixed", () => {
  // teacher-dashboard 至今仍指向舊帳號 gpge0805 是實際發生過的情況——
  // 這條規則就是為了擋住「自動改掉 remote」或「直接推到別人帳號」。
  const decision = decideRepoAction({
    remote: { owner: "gpge0805", repo: "resistor-quiz" },
    expectedAccount: "ncueyu",
    remoteRepoExists: false,
    slug: "resistor-quiz",
  });

  assert.equal(decision.type, "stop");
  assert.match(decision.reason, /gpge0805.*ncueyu|帳號/);
});

test("decideRepoAction: remote points to the right account but a different repo name -> stop", () => {
  const decision = decideRepoAction({
    remote: { owner: "ncueyu", repo: "some-other-project" },
    expectedAccount: "ncueyu",
    remoteRepoExists: false,
    slug: "resistor-quiz",
  });

  assert.equal(decision.type, "stop");
  assert.match(decision.reason, /代稱|slug/);
});

test("decideRepoAction: remote already matches expected account and slug -> push", () => {
  const decision = decideRepoAction({
    remote: { owner: "ncueyu", repo: "resistor-quiz" },
    expectedAccount: "ncueyu",
    remoteRepoExists: false,
    slug: "resistor-quiz",
  });

  assert.equal(decision.type, "push");
});

// ── publishToGithub：全流程整合，全部透過假的 runCommand，不碰真實 gh/git ──

/**
 * 建一個最小專案資料夾。
 *
 * @param {{ withSecret?: boolean, withGit?: boolean }} [options]
 * @returns {string}
 */
function makeProject(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-github-"));

  writeFileSync(join(dir, "project-hub.json"), JSON.stringify({ name: "測試專案", slug: "test-project" }));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>\n");

  if (options.withSecret) {
    writeFileSync(join(dir, "config.js"), `export const key = "${FAKE_AWS_KEY}";\n`);
  }

  if (options.withGit) {
    mkdirSync(join(dir, ".git"));
  }

  return dir;
}

/**
 * 假的外部指令執行器。依 (command, args) 分派固定回應，未預期的組合直接
 * 拋錯——寧可測試失敗得吵，也不要靜默回傳看似合理但其實錯誤的結果。
 *
 * @param {Record<string, any>} config
 * @param {string[][]} calls
 */
function makeFakeRunner(config, calls) {
  return async function fakeRun(command, args) {
    calls.push([command, ...args]);

    if (command === "gh" && args[0] === "--version") {
      return config.ghInstalled === false
        ? { code: 127, stdout: "", stderr: "not found" }
        : { code: 0, stdout: "gh version 2.0.0", stderr: "" };
    }

    if (command === "gh" && args[0] === "auth" && args[1] === "status") {
      if (!config.activeAccount) {
        return { code: 1, stdout: "", stderr: "you are not logged into any GitHub hosts" };
      }

      return {
        code: 0,
        stdout: `github.com\n  ✓ Logged in to github.com account ${config.activeAccount} (keyring)\n  - Active account: true\n`,
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
        : { code: 1, stdout: "", stderr: "GraphQL: Could not resolve" };
    }

    if (command === "git" && args[0] === "init") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "add") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "status" && args[1] === "--porcelain") {
      return { code: 0, stdout: config.hasChanges === false ? "" : " M index.html\n", stderr: "" };
    }

    if (command === "git" && args[0] === "commit") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "gh" && args[0] === "repo" && args[1] === "create") {
      return config.createOk === false
        ? { code: 1, stdout: "", stderr: "HTTP 422: name already exists" }
        : { code: 0, stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "remote" && args[1] === "add") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "git" && args[0] === "push") {
      return config.pushOk === false ? { code: 1, stdout: "", stderr: "rejected" } : { code: 0, stdout: "", stderr: "" };
    }

    if (command === "gh" && args[0] === "repo" && args[1] === "view" && args.includes("--json")) {
      return {
        code: 0,
        stdout: JSON.stringify({ visibility: config.finalVisibility ?? "PRIVATE", name: "test-project" }),
        stderr: "",
      };
    }

    throw new Error(`測試沒有預期到這個呼叫：${command} ${args.join(" ")}`);
  };
}

const ALWAYS_YES = async () => true;

test("B1: gh not installed stops immediately and touches nothing else", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject(), {
    confirm: ALWAYS_YES,
    runCommand: makeFakeRunner({ ghInstalled: false }, calls),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "gh-installed");
  assert.equal(result.steps.at(-1).status, "stopped");
  // 只呼叫了 gh --version 這一步，沒有嘗試登入檢查、掃描或任何 git/gh 動作。
  assert.deepEqual(calls, [["gh", "--version"]]);
});

test("rejecting the target-folder confirmation stops before any command runs", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject(), {
    confirm: async () => false,
    runCommand: makeFakeRunner({ ghInstalled: true, activeAccount: "ncueyu" }, calls),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "confirm-target");
  assert.deepEqual(calls, [], "使用者還沒確認目標資料夾前，不該執行任何外部指令");
});

test("not logged in to gh stops before touching git", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject(), {
    confirm: ALWAYS_YES,
    runCommand: makeFakeRunner({ ghInstalled: true, activeAccount: null }, calls),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "gh-logged-in");
  assert.deepEqual(calls, [["gh", "--version"], ["gh", "auth", "status"]]);
});

test("rejecting the active-account confirmation stops before any git/repo action", async () => {
  const calls = [];
  let askedAccount = false;

  const result = await publishToGithub(makeProject(), {
    confirm: async (message) => {
      if (message.includes("作用中的 GitHub 帳號")) {
        askedAccount = true;
        return false;
      }

      return true;
    },
    runCommand: makeFakeRunner({ ghInstalled: true, activeAccount: "ncueyu" }, calls),
  });

  assert.equal(askedAccount, true);
  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "confirm-account");
  assert.deepEqual(calls, [["gh", "--version"], ["gh", "auth", "status"]]);
});

test("B4: remote pointing at a different account stops and is reported, never auto-fixed", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject({ withGit: true }), {
    confirm: ALWAYS_YES,
    runCommand: makeFakeRunner(
      { ghInstalled: true, activeAccount: "ncueyu", remoteUrl: "https://github.com/gpge0805/test-project.git" },
      calls,
    ),
  });

  assert.equal(result.ok, false);
  const stopStep = result.steps.at(-1);

  assert.equal(stopStep.step, "decide-action");
  assert.match(stopStep.detail, /gpge0805/);
  // 沒有任何一次呼叫是 git push 或 gh repo create——絕不強推、絕不自動改 remote。
  assert.equal(calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "push"), false);
  assert.equal(calls.some(([cmd, ...args]) => cmd === "gh" && args[0] === "repo" && args[1] === "create"), false);
});

test("B3: a blocked secret stops the whole flow even when every confirmation would say yes", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject({ withSecret: true }), {
    confirm: ALWAYS_YES,
    runCommand: makeFakeRunner(
      { ghInstalled: true, activeAccount: "ncueyu", remoteRepoExists: false },
      calls,
    ),
  });

  assert.equal(result.ok, false);
  const scanStep = result.steps.find((step) => step.step === "scan");

  assert.equal(scanStep.status, "stopped");
  // 掃描發現阻擋級問題後，不該再有任何 init/commit/create/push 動作。
  assert.equal(calls.some(([cmd, ...args]) => cmd === "git" && (args[0] === "init" || args[0] === "commit")), false);
  assert.equal(calls.some(([cmd, ...args]) => cmd === "gh" && args[0] === "repo" && args[1] === "create"), false);
  assert.equal(calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "push"), false);
});

test("B5 + B6: first-time publish creates a private repo end to end", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject(), {
    confirm: ALWAYS_YES,
    runCommand: makeFakeRunner(
      { ghInstalled: true, activeAccount: "ncueyu", remoteRepoExists: false, hasChanges: true, finalVisibility: "PRIVATE" },
      calls,
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.repoUrl, "https://github.com/ncueyu/test-project");

  const createCall = calls.find(([cmd, ...args]) => cmd === "gh" && args[0] === "repo" && args[1] === "create");

  assert.ok(createCall, "應該呼叫 gh repo create");
  assert.ok(createCall.includes("--private"), "建立的 repo 必須是 private");
  assert.equal(calls.some(([cmd, ...args]) => cmd === "gh" && args.includes("--source")), true);

  const verifyStep = result.steps.at(-1);

  assert.equal(verifyStep.step, "verify");
  assert.equal(verifyStep.status, "ok");
});

test("B5: an existing remote matching the expected account pushes without recreating the repo", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject({ withGit: true }), {
    confirm: ALWAYS_YES,
    runCommand: makeFakeRunner(
      {
        ghInstalled: true,
        activeAccount: "ncueyu",
        remoteUrl: "https://github.com/ncueyu/test-project.git",
        hasChanges: false,
        finalVisibility: "PRIVATE",
      },
      calls,
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(calls.some(([cmd, ...args]) => cmd === "gh" && args[0] === "repo" && args[1] === "create"), false, "已存在的專案不該再呼叫 gh repo create");
  assert.equal(calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "push" && args.length === 1), true);
});

test("collision case: same-named repo exists with no local remote asks for confirmation before linking", async () => {
  const calls = [];
  let askedAboutCollision = false;

  const confirm = async (message) => {
    if (message.includes("撞名")) {
      askedAboutCollision = true;
    }

    return true;
  };

  const result = await publishToGithub(makeProject(), {
    confirm,
    runCommand: makeFakeRunner(
      { ghInstalled: true, activeAccount: "ncueyu", remoteRepoExists: true, hasChanges: true, finalVisibility: "PRIVATE" },
      calls,
    ),
  });

  assert.equal(askedAboutCollision, true, "撞名情境必須明確問使用者，不能悄悄接上");
  assert.equal(result.ok, true);
  assert.equal(calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "remote" && args[1] === "add"), true);
});

test("declining the collision confirmation stops without linking or pushing", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject(), {
    confirm: async (message) => !message.includes("撞名"),
    runCommand: makeFakeRunner({ ghInstalled: true, activeAccount: "ncueyu", remoteRepoExists: true }, calls),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "decide-action");
  assert.equal(calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "push"), false);
});

test("B7: a failed push is reported as its own step, not swallowed into a generic failure", async () => {
  const calls = [];
  const result = await publishToGithub(makeProject({ withGit: true }), {
    confirm: ALWAYS_YES,
    runCommand: makeFakeRunner(
      {
        ghInstalled: true,
        activeAccount: "ncueyu",
        remoteUrl: "https://github.com/ncueyu/test-project.git",
        pushOk: false,
      },
      calls,
    ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1).step, "publish");
  assert.match(result.steps.at(-1).detail, /rejected/);
});

test("B6: if the repo somehow ends up non-private, verification reports it instead of claiming success", async () => {
  const result = await publishToGithub(makeProject(), {
    confirm: ALWAYS_YES,
    runCommand: makeFakeRunner(
      { ghInstalled: true, activeAccount: "ncueyu", remoteRepoExists: false, finalVisibility: "PUBLIC" },
      [],
    ),
  });

  assert.equal(result.ok, false);
  const verifyStep = result.steps.at(-1);

  assert.equal(verifyStep.step, "verify");
  assert.match(verifyStep.detail, /PUBLIC/);
});
