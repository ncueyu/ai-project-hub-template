import assert from "node:assert/strict";
import test from "node:test";

import {
  DENY_REASONS,
  SESSION_COOKIE_NAME,
  buildClearedSessionCookie,
  buildSessionCookie,
  createAccessGate,
  importSigningKey,
  issueSession,
  readSessionCookie,
  verifySession,
} from "../src/access-gate/index.js";

/** 測試專用的假金鑰。正式環境一律使用 Cloudflare Secret，不得沿用這個值。 */
const TEST_SECRET = "test-only-signing-key-do-not-use-in-production-0123456789";

const NOW = 1_780_000_000;
const VALID_CLAIMS = { project_id: 4, policy_version: 1, expires_at: NOW + 3600 };
const EXPECTED = { projectId: 4, policyVersion: 1, now: NOW };

async function key() {
  return importSigningKey(TEST_SECRET);
}

function requestWithCookie(value) {
  return new Request("https://project.example.test/", {
    headers: value === null ? {} : { Cookie: value },
  });
}

test("a freshly issued session is accepted", async () => {
  const signingKey = await key();
  const token = await issueSession(signingKey, VALID_CLAIMS);
  const result = await verifySession(signingKey, token, EXPECTED);

  assert.equal(result.allowed, true);
  assert.deepEqual(result.claims, VALID_CLAIMS);
});

test("a tampered signature is rejected", async () => {
  const signingKey = await key();
  const token = await issueSession(signingKey, VALID_CLAIMS);

  const parts = token.split(".");
  parts[2] = parts[2].slice(0, -4) + "AAAA";

  const result = await verifySession(signingKey, parts.join("."), EXPECTED);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.BAD_SIGNATURE);
});

test("a tampered payload is rejected even if it is valid json", async () => {
  const signingKey = await key();
  const token = await issueSession(signingKey, VALID_CLAIMS);
  const parts = token.split(".");

  // 竄改者把有效期改到很久以後，但沒有金鑰就無法重新簽章。
  const forged = { ...VALID_CLAIMS, expires_at: NOW + 999_999 };
  const encoded = Buffer.from(JSON.stringify(forged))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = await verifySession(signingKey, `${parts[0]}.${encoded}.${parts[2]}`, EXPECTED);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.BAD_SIGNATURE);
});

test("an expired session is rejected", async () => {
  const signingKey = await key();
  const token = await issueSession(signingKey, { ...VALID_CLAIMS, expires_at: NOW - 1 });
  const result = await verifySession(signingKey, token, EXPECTED);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.EXPIRED);
});

test("a session expiring exactly now is rejected", async () => {
  const signingKey = await key();
  const token = await issueSession(signingKey, { ...VALID_CLAIMS, expires_at: NOW });
  const result = await verifySession(signingKey, token, EXPECTED);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.EXPIRED);
});

test("a session issued for another project is rejected", async () => {
  const signingKey = await key();
  const token = await issueSession(signingKey, { ...VALID_CLAIMS, project_id: 99 });
  const result = await verifySession(signingKey, token, EXPECTED);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.PROJECT_MISMATCH);
});

test("a session from an older policy version is rejected", async () => {
  // 擁有者改密碼後會提高 policy_version，已發出的權杖必須立刻失效。
  const signingKey = await key();
  const token = await issueSession(signingKey, { ...VALID_CLAIMS, policy_version: 1 });
  const result = await verifySession(signingKey, token, { ...EXPECTED, policyVersion: 2 });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.POLICY_VERSION_MISMATCH);
});

test("a session signed with a different key is rejected", async () => {
  const signingKey = await key();
  const otherKey = await importSigningKey("a-completely-different-signing-key-0123456789abcdef");
  const token = await issueSession(otherKey, VALID_CLAIMS);
  const result = await verifySession(signingKey, token, EXPECTED);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.BAD_SIGNATURE);
});

test("malformed tokens never throw and never return 500-worthy errors", async () => {
  const signingKey = await key();

  const garbage = [
    null,
    undefined,
    "",
    "not-a-token",
    "v1.only-two-parts",
    "v1.a.b.c.d",
    "v2.abc.def",
    "v1..",
    "v1.!!!not-base64!!!.###",
    "v1." + Buffer.from("not json").toString("base64url") + ".sig",
    "v1." + Buffer.from(JSON.stringify({ project_id: "4" })).toString("base64url") + ".sig",
    "a".repeat(10000),
  ];

  for (const token of garbage) {
    const result = await verifySession(signingKey, token, EXPECTED);

    assert.equal(result.allowed, false, `應拒絕：${String(token).slice(0, 30)}`);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
  }
});

test("claims with wrong value types are rejected as malformed", async () => {
  const signingKey = await key();

  // 簽章正確但欄位型別不對：仍必須拒絕，不可信任內容形狀。
  const payload = Buffer.from(JSON.stringify({
    project_id: "4",
    policy_version: 1,
    expires_at: NOW + 3600,
  })).toString("base64url");

  const message = `v1.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(message));
  const encodedSignature = Buffer.from(new Uint8Array(signature)).toString("base64url");

  const result = await verifySession(signingKey, `${message}.${encodedSignature}`, EXPECTED);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.MALFORMED);
});

test("a missing cookie is reported as missing, not as an error", async () => {
  const signingKey = await key();
  const result = await verifySession(signingKey, null, EXPECTED);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, DENY_REASONS.MISSING);
});

test("signing keys that are too short are rejected outright", async () => {
  await assert.rejects(() => importSigningKey("too-short"));
  await assert.rejects(() => importSigningKey(""));
});

test("session cookies carry every required attribute", () => {
  const cookie = buildSessionCookie("token-value", { maxAge: 3600 });

  assert.ok(cookie.includes("HttpOnly"), "必須是 HttpOnly");
  assert.ok(cookie.includes("SameSite=Lax"), "必須是 SameSite=Lax");
  assert.ok(cookie.includes("Path=/"), "必須指定 Path");
  assert.ok(cookie.includes("Max-Age=3600"), "必須有明確的 Max-Age");
  assert.ok(cookie.includes("Secure"), "預設必須是 Secure");
  assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
});

test("the cookie name reveals nothing about the project", () => {
  assert.equal(/project|password|secret|admin/i.test(SESSION_COOKIE_NAME), false);
});

test("secure can be disabled only for local http development", () => {
  const local = buildSessionCookie("token-value", { secure: false });

  assert.equal(local.includes("Secure"), false);
  assert.ok(local.includes("HttpOnly"), "即使在本機也必須是 HttpOnly");
});

test("clearing the cookie sets Max-Age to zero", () => {
  assert.ok(buildClearedSessionCookie().includes("Max-Age=0"));
});

test("cookie parsing copes with other cookies and odd spacing", () => {
  assert.equal(readSessionCookie(requestWithCookie("hub_session=abc")), "abc");
  assert.equal(readSessionCookie(requestWithCookie("other=1; hub_session=abc; more=2")), "abc");
  assert.equal(readSessionCookie(requestWithCookie("  hub_session = abc  ")), "abc");
  assert.equal(readSessionCookie(requestWithCookie("other=1")), null);
  assert.equal(readSessionCookie(requestWithCookie("")), null);
  assert.equal(readSessionCookie(requestWithCookie(null)), null);
  assert.equal(readSessionCookie(requestWithCookie("malformed")), null);
  assert.equal(readSessionCookie(requestWithCookie("hub_session=")), null);
});

test("cookie parsing does not match a similarly named cookie", () => {
  assert.equal(readSessionCookie(requestWithCookie("not_hub_session=abc")), null);
  assert.equal(readSessionCookie(requestWithCookie("hub_session_backup=abc")), null);
});

test("the gate reads the cookie and validates in one call", async () => {
  const signingKey = await key();
  const gate = createAccessGate({ signingKey, projectId: 4, policyVersion: 1 });
  const token = await issueSession(signingKey, VALID_CLAIMS);

  const allowed = await gate.check(requestWithCookie(`hub_session=${token}`), { now: NOW });
  assert.equal(allowed.allowed, true);

  const denied = await gate.check(requestWithCookie("hub_session=broken"), { now: NOW });
  assert.equal(denied.allowed, false);

  const none = await gate.check(requestWithCookie(null), { now: NOW });
  assert.equal(none.reason, DENY_REASONS.MISSING);
});

test("verification performs no database or password hashing work", async () => {
  // 這個測試守住 TASK-2.9 的核心限制：驗證路徑不得碰資料庫或 PBKDF2。
  // 若日後有人在驗證流程加入這類呼叫，這裡會立刻失敗。
  const source = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/access-gate/session.js", import.meta.url), "utf8"));

  // 比對實際的用法而非單純字串：說明「為何不使用 PBKDF2」的註解本身
  // 就含有這個詞，用字串比對會誤判。
  assert.equal(/name:\s*["']PBKDF2["']/.test(source), false, "驗證路徑不可使用 PBKDF2 演算法");
  assert.equal(/deriveBits|deriveKey/.test(source), false, "驗證路徑不可做金鑰衍生");
  assert.equal(source.includes(".prepare("), false, "驗證路徑不可查詢資料庫");
  assert.equal(/\benv\.DB\b/.test(source), false, "驗證路徑不可取用資料庫繫結");
});
