import assert from "node:assert/strict";
import test from "node:test";

import { importSigningKey, issueSession } from "../src/access-gate/session.js";
import { hashPassword, verifyPassword } from "../src/access-gate/password.js";
import {
  LOGIN_PATH,
  LOGOUT_PATH,
  createProtectedWorker,
} from "../src/access-gate/protected-worker.js";

/** 測試專用假金鑰，正式環境一律使用 Cloudflare Secret。 */
const TEST_SECRET = "test-only-signing-key-do-not-use-in-production-0123456789";
const PASSWORD = "correct horse battery staple";

/** 測試用的低重複次數，只為讓測試快速完成，不代表正式參數。 */
const TEST_ITERATIONS = 1000;

const NOW = 1_780_000_000;

let signingKey;
let passwordHash;

test.before(async () => {
  signingKey = await importSigningKey(TEST_SECRET);
  passwordHash = await hashPassword(PASSWORD, { iterations: TEST_ITERATIONS });
});

function createEnv() {
  const calls = [];

  return {
    calls,
    SESSION_SIGNING_KEY: TEST_SECRET,
    ASSETS: {
      async fetch(request) {
        calls.push(new URL(request.url).pathname);
        return new Response("PROTECTED CONTENT", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
  };
}

function worker(overrides = {}) {
  return createProtectedWorker({
    projectId: 4,
    visibility: "password",
    policyVersion: 1,
    passwordHash,
    projectName: "PLC 實習講義",
    secureCookie: false,
    ...overrides,
  });
}

// 注意展開順序：`...init` 必須放在 headers 之前，
// 否則 init.headers 會把合併好的標頭整個蓋掉。
function pageRequest(path = "/", init = {}) {
  return new Request(`https://project.example.test${path}`, {
    ...init,
    headers: { "Sec-Fetch-Dest": "document", ...init.headers },
  });
}

function assetRequest(path, init = {}) {
  return new Request(`https://project.example.test${path}`, {
    ...init,
    headers: { "Sec-Fetch-Dest": "script", ...init.headers },
  });
}

async function login(w, env, password) {
  const body = new URLSearchParams({ password });

  return w.fetch(
    new Request(`https://project.example.test${LOGIN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
    env,
    { signingKey },
  );
}

function cookieFrom(response) {
  const header = response.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0];
}

// ---------------------------------------------------------------- 必測六項

test("1. a wrong password is rejected without revealing why", async () => {
  const env = createEnv();
  const response = await login(worker(), env, "wrong password");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Set-Cookie"), null, "失敗時不可簽發工作階段");
  assert.ok(html.includes("密碼不正確"));
  assert.equal(env.calls.length, 0, "失敗時不可觸及受保護內容");

  // 錯誤訊息不得洩漏雜湊、鹽值或內部細節
  for (const leak of ["pbkdf2", "salt", "hash", "iterations", TEST_SECRET]) {
    assert.equal(html.toLowerCase().includes(leak.toLowerCase()), false, `不可洩漏 ${leak}`);
  }
});

test("2. the correct password issues a session and grants access", async () => {
  const env = createEnv();
  const w = worker();

  const response = await login(w, env, PASSWORD);
  assert.equal(response.status, 303);

  const cookie = cookieFrom(response);
  assert.ok(cookie.startsWith("hub_session="));

  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("SameSite=Lax"));
  assert.ok(setCookie.includes("Max-Age="));

  const page = await w.fetch(pageRequest("/", { headers: { Cookie: cookie } }), env, { signingKey });

  assert.equal(page.status, 200);
  assert.equal(await page.text(), "PROTECTED CONTENT");
});

test("3. an expired session is refused", async () => {
  const env = createEnv();
  const w = worker();
  const token = await issueSession(signingKey, {
    project_id: 4,
    policy_version: 1,
    expires_at: NOW - 1,
  });

  const response = await w.fetch(
    pageRequest("/", { headers: { Cookie: `hub_session=${token}` } }),
    env,
    { signingKey, now: NOW },
  );

  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("需要密碼"), "應回到密碼頁");
  assert.equal(env.calls.length, 0);
});

test("4. a tampered session is refused", async () => {
  const env = createEnv();
  const w = worker();
  const token = await issueSession(signingKey, {
    project_id: 4,
    policy_version: 1,
    expires_at: NOW + 3600,
  });

  const tampered = token.slice(0, -6) + "AAAAAA";
  const response = await w.fetch(
    assetRequest("/app.js", { headers: { Cookie: `hub_session=${tampered}` } }),
    env,
    { signingKey, now: NOW },
  );

  assert.equal(response.status, 404);
  assert.equal(env.calls.length, 0);
});

test("5. a session for another project is refused", async () => {
  const env = createEnv();
  const w = worker();
  const token = await issueSession(signingKey, {
    project_id: 99,
    policy_version: 1,
    expires_at: NOW + 3600,
  });

  const response = await w.fetch(
    pageRequest("/", { headers: { Cookie: `hub_session=${token}` } }),
    env,
    { signingKey, now: NOW },
  );

  assert.ok((await response.text()).includes("需要密碼"));
  assert.equal(env.calls.length, 0);
});

test("6. a session from an older policy version is refused", async () => {
  const env = createEnv();
  const w = worker({ policyVersion: 2 });
  const token = await issueSession(signingKey, {
    project_id: 4,
    policy_version: 1,
    expires_at: NOW + 3600,
  });

  const response = await w.fetch(
    pageRequest("/", { headers: { Cookie: `hub_session=${token}` } }),
    env,
    { signingKey, now: NOW },
  );

  const body = await response.text();
  assert.ok(
    body.includes("需要密碼"),
    `實際回應 status=${response.status} body=${body.slice(0, 160)}`,
  );
  assert.equal(env.calls.length, 0);
});

// ---------------------------------------------------------------- 追加必測

test("unauthenticated sub-resources are refused, not shown the password page", async () => {
  const env = createEnv();
  const w = worker();

  for (const path of ["/app.js", "/styles.css", "/logo.png", "/data.json"]) {
    const response = await w.fetch(assetRequest(path), env, { signingKey, now: NOW });

    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8", path);
  }

  assert.equal(env.calls.length, 0, "未驗證時不可觸及任何受保護資源");
});

test("an invalid cookie never leaks content", async () => {
  const env = createEnv();
  const w = worker();

  const cookies = ["", "hub_session=", "hub_session=garbage", "other=1", "hub_session=v1.a.b"];

  for (const cookie of cookies) {
    const response = await w.fetch(
      assetRequest("/app.js", { headers: { Cookie: cookie } }),
      env,
      { signingKey, now: NOW },
    );

    assert.equal(response.status, 404, cookie);
  }

  assert.equal(env.calls.length, 0);
});

test("authenticated asset requests do no password hashing", async () => {
  // 若後續每個請求都重跑 PBKDF2，Workers 免費方案的 10ms CPU 上限會直接爆掉。
  //
  // 這裡不用執行時間來判斷——測試用的重複次數很低，時間差會被雜訊淹沒。
  // 改為驗證結構：密碼驗證在整份程式中只被呼叫一次，且位於登入處理函式內。
  const env = createEnv();
  const w = worker();

  const loginResponse = await login(w, env, PASSWORD);
  const cookie = cookieFrom(loginResponse);

  for (let i = 0; i < 20; i += 1) {
    const response = await w.fetch(
      assetRequest(`/asset-${i}.js`, { headers: { Cookie: cookie } }),
      env,
      { signingKey },
    );

    assert.equal(response.status, 200, `第 ${i} 次資源請求應成功`);
  }

  assert.equal(env.calls.length, 20, "20 次請求都應取得資源");

  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/access-gate/protected-worker.js", import.meta.url),
    "utf8",
  );

  const calls = [...source.matchAll(/\bverifyPassword\s*\(/g)];
  assert.equal(calls.length, 1, "密碼驗證在整份程式中只應出現一次");

  const loginHandlerIndex = source.indexOf("async function handleLogin");
  assert.ok(loginHandlerIndex > -1, "應存在登入處理函式");
  assert.ok(
    calls[0].index > loginHandlerIndex,
    "密碼驗證必須位於登入處理函式內，不可出現在資源請求路徑",
  );
});

test("no bcrypt or argon2 anywhere in the access gate", async () => {
  const { readFile } = await import("node:fs/promises");

  // 檢查實際的匯入與呼叫，而不是任意文字：
  // 說明「為何不採用 bcrypt／Argon2」的註解本身就含有這些詞。
  for (const file of ["session.js", "password.js", "protected-worker.js", "index.js"]) {
    const source = await readFile(new URL(`../src/access-gate/${file}`, import.meta.url), "utf8");

    assert.equal(
      /(?:from|require\()\s*["'][^"']*(bcrypt|argon2|scrypt)/i.test(source),
      false,
      `${file} 不可匯入 bcrypt／argon2／scrypt`,
    );
    assert.equal(
      /\b(bcrypt|argon2|scrypt)\s*[.(]/i.test(source),
      false,
      `${file} 不可呼叫 bcrypt／argon2／scrypt`,
    );
  }

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  for (const name of Object.keys(deps)) {
    assert.equal(/bcrypt|argon2|scrypt/i.test(name), false, `相依套件不可含 ${name}`);
  }
});

test("logout clears the session cookie", async () => {
  const env = createEnv();
  const w = worker();

  const response = await w.fetch(
    new Request(`https://project.example.test${LOGOUT_PATH}`, { method: "POST" }),
    env,
    { signingKey },
  );

  assert.equal(response.status, 303);
  assert.ok(response.headers.get("Set-Cookie").includes("Max-Age=0"));
});

test("a missing signing key fails closed", async () => {
  const env = createEnv();
  delete env.SESSION_SIGNING_KEY;

  const response = await worker().fetch(pageRequest("/"), env, {});

  assert.equal(response.status, 404, "沒有金鑰時不可提供內容");
  assert.equal(env.calls.length, 0);
});

test("the password page is self-contained and not indexable", async () => {
  const env = createEnv();
  const response = await worker().fetch(pageRequest("/"), env, { signingKey, now: NOW });
  const html = await response.text();

  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  // 密碼頁不能引用外部檔案，那些檔案本身也被擋住。
  assert.equal(/<link[^>]+href=/.test(html), false, "不可引用外部樣式");
  assert.equal(/<script[^>]+src=/.test(html), false, "不可引用外部指令碼");
});

// ---------------------------------------------------------------- Private

test("private projects refuse pages and every sub-resource", async () => {
  const env = createEnv();
  const w = worker({ visibility: "private" });

  for (const request of [
    pageRequest("/"),
    pageRequest("/index.html"),
    assetRequest("/app.js"),
    assetRequest("/styles.css"),
    assetRequest("/photo.png"),
  ]) {
    const response = await w.fetch(request, env, { signingKey });

    assert.equal(response.status, 404, request.url);
  }

  assert.equal(env.calls.length, 0, "私人專案不可送出任何內容");
});

test("private projects open for an authorised admin", async () => {
  const env = createEnv();
  const w = worker({
    visibility: "private",
    isAdmin: (request) => request.headers.get("Cf-Access-Authenticated-User-Email") === "owner@example.test",
  });

  const denied = await w.fetch(pageRequest("/"), env, { signingKey });
  assert.equal(denied.status, 404);

  const allowed = await w.fetch(
    pageRequest("/", { headers: { "Cf-Access-Authenticated-User-Email": "owner@example.test" } }),
    env,
    { signingKey },
  );

  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), "PROTECTED CONTENT");
});

test("private projects never fall back to the password page", async () => {
  // 私人不是「輸入密碼就能看」，因此不該出現密碼頁——那會暗示可以嘗試闖入。
  const env = createEnv();
  const response = await worker({ visibility: "private" }).fetch(pageRequest("/"), env, { signingKey });

  assert.equal((await response.text()).includes("需要密碼"), false);
});

// ---------------------------------------------------------------- Disabled

test("disabled projects refuse everyone, including admins", async () => {
  const env = createEnv();
  const w = worker({
    visibility: "disabled",
    isAdmin: () => true,
  });

  for (const request of [
    pageRequest("/"),
    assetRequest("/app.js"),
    new Request(`https://project.example.test${LOGIN_PATH}`, { method: "POST" }),
  ]) {
    const response = await w.fetch(request, env, { signingKey });

    assert.equal(response.status, 404, request.url);
  }

  assert.equal(env.calls.length, 0);
});

test("disabled and private are indistinguishable from outside", async () => {
  // 狀態碼或內容若有差異，外部就能推斷出該網址確實存在某個東西。
  const env = createEnv();

  const disabled = await worker({ visibility: "disabled" }).fetch(pageRequest("/"), env, { signingKey });
  const privateProject = await worker({ visibility: "private" }).fetch(pageRequest("/"), env, { signingKey });

  assert.equal(disabled.status, privateProject.status);
  assert.equal(await disabled.text(), await privateProject.text());
  assert.equal(
    disabled.headers.get("Content-Type"),
    privateProject.headers.get("Content-Type"),
  );
});

// ---------------------------------------------------------------- 密碼雜湊本身

test("password hashes never store the plain text", async () => {
  const hash = await hashPassword("my-secret-password", { iterations: TEST_ITERATIONS });

  assert.equal(hash.includes("my-secret-password"), false);
  assert.ok(hash.startsWith("pbkdf2-sha256$"));
  assert.equal(hash.split("$").length, 4);
});

test("the same password produces different hashes each time", async () => {
  // 每次都要有新的隨機鹽值，否則相同密碼會產生相同雜湊，形同可比對的指紋。
  const a = await hashPassword(PASSWORD, { iterations: TEST_ITERATIONS });
  const b = await hashPassword(PASSWORD, { iterations: TEST_ITERATIONS });

  assert.notEqual(a, b);
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
});

test("verification fails safely on malformed stored hashes", async () => {
  for (const bad of ["", "not-a-hash", "pbkdf2-sha256$abc$x$y", "pbkdf2-sha256$1000$!!!$!!!", null, undefined]) {
    assert.equal(await verifyPassword(PASSWORD, bad), false, String(bad));
  }
});

test("an empty password never verifies", async () => {
  assert.equal(await verifyPassword("", passwordHash), false);
});
