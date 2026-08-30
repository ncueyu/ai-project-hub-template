import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blankComments, toLineColumn } from "../tools/source-text.mjs";
import {
  collectFiles,
  isTestPath,
  looksLikePlaceholder,
  mask,
  scanDirectory,
  scanText,
} from "../tools/secrets.mjs";

/** 樣子正確、但不是任何真實系統的金鑰，僅供測試比對。 */
const FAKE_AWS_KEY = `AKIA${"TESTKEY0EXAMPLE1"}`;
const FAKE_GOOGLE_KEY = `AIza${"SyTESTONLY0000000000000000000000000"}`;

test("a comment that mentions a key is not a leak", () => {
  // 這是本專案踩過三次的坑：說明文字本身含有要偵測的關鍵字。
  const source = [
    "// 不要把 AWS 金鑰寫在原始碼裡，例如 " + FAKE_AWS_KEY,
    "/* 同理，api_key = \"real-looking-value-here\" 也不該出現 */",
    "const client = createClient();",
  ].join("\n");

  assert.deepEqual(scanText("example.js", source), []);
});

test("the same key outside a comment is reported", () => {
  const source = `const key = "${FAKE_AWS_KEY}";`;
  const findings = scanText("example.js", source);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "aws-access-key");
});

test("line numbers survive multi-line comments", () => {
  const source = [
    "/**",
    " * 一段說明。",
    " * 再一行。",
    " */",
    "",
    `const key = "${FAKE_GOOGLE_KEY}";`,
  ].join("\n");

  const findings = scanText("example.js", source);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 6, "行號位移會把使用者指到錯誤的位置");
});

test("blankComments keeps the file the same length and shape", () => {
  const source = "const a = 1; // 說明\n/* 區塊\n說明 */\nconst b = 2;\n";
  const blanked = blankComments(source);

  assert.equal(blanked.length, source.length);
  assert.equal(blanked.split("\n").length, source.split("\n").length);
  assert.ok(blanked.includes("const a = 1;"));
  assert.ok(!blanked.includes("說明"));
});

test("a URL inside a string is not mistaken for a comment", () => {
  const source = 'const url = "https://example.test/path"; // 註解';
  const blanked = blankComments(source);

  assert.ok(blanked.includes("https://example.test/path"));
  assert.ok(!blanked.includes("註解"));
});

test("placeholder values are not treated as leaks", () => {
  const placeholders = [
    'api_key = "your-api-key-here"',
    'token: "${GITHUB_TOKEN}"',
    'password = "change-me-please"',
    'secret = "xxxxxxxxxxxxxxxx"',
    'signing_key = "local-development-only-signing-key"',
    'auth_token = "process.env.AUTH_TOKEN"',
  ];

  for (const line of placeholders) {
    assert.deepEqual(scanText("example.js", line), [], `不該被當成外洩：${line}`);
  }

  assert.ok(looksLikePlaceholder("<your-token>"));
  assert.ok(!looksLikePlaceholder("8f3a91cc2b7e4d6a90f1"));
});

test("an error message assigned to a password field is not a leak", () => {
  // 實測發現的誤判：src/routes/policies.js 把驗證訊息指派給 fields.password，
  // 原本的樣式把整句中文當成密碼。
  const messages = [
    'fields.password = "長度必須介於 8 到 128 個字元。";',
    'fields.password = "必須是文字，且不接受空白密碼。";',
    'const hint = { token: "請貼上你的權杖" };',
    'password: "correct horse battery staple"',
  ];

  for (const line of messages) {
    assert.deepEqual(scanText("example.js", line), [], `不該被當成外洩：${line}`);
  }
});

test("test files are labelled so they can be judged separately", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-secrets-"));

  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "a.test.mjs"), `const k = "${FAKE_AWS_KEY}";\n`);
  writeFileSync(join(dir, "app.js"), `const k = "${FAKE_AWS_KEY}";\n`);

  const { findings } = scanDirectory(dir);
  const contexts = Object.fromEntries(findings.map((finding) => [finding.path, finding.context]));

  assert.equal(contexts["test/a.test.mjs"], "test");
  assert.equal(contexts["app.js"], "source");

  assert.ok(isTestPath("test/a.test.mjs"));
  assert.ok(isTestPath("src/__tests__/b.mjs"));
  assert.ok(!isTestPath("src/latest/config.js"));
});

test("a hardcoded secret assignment is reported with its location", () => {
  const source = 'const config = {\n  api_key: "8f3a91cc2b7e4d6a90f1e2",\n};';
  const findings = scanText("config.js", source);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "hardcoded-secret");
  assert.equal(findings[0].line, 2);
});

test("private key blocks and JWTs are recognised", () => {
  const pem = scanText("key.pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n");
  const jwt = scanText(
    "token.txt",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  );

  assert.equal(pem[0].rule, "private-key");
  assert.equal(jwt[0].rule, "jwt");
});

test("an explicit marker silences a single line, not the whole rule", () => {
  const marked = [
    `const a = "${FAKE_AWS_KEY}"; // hub-ignore-secret：測試用`,
    "// hub-ignore-secret：下一行是刻意的",
    `const b = "${FAKE_AWS_KEY}";`,
  ].join("\n");

  assert.deepEqual(scanText("example.js", marked), []);

  // 沒有標記的同一份檔案仍然會被抓到——標記只作用在被標的那一行。
  const unmarked = `const a = "${FAKE_AWS_KEY}";\nconst b = "${FAKE_AWS_KEY}";`;

  assert.equal(scanText("example.js", unmarked).length, 2);
});

test("reported excerpts are masked so the report itself is not a leak", () => {
  const findings = scanText("example.js", `const key = "${FAKE_AWS_KEY}";`);

  assert.ok(!findings[0].excerpt.includes(FAKE_AWS_KEY));
  assert.match(findings[0].excerpt, /\*/);
  assert.equal(mask("short"), "*****");
});

test("template files are skipped because fake values belong there", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-secrets-"));

  writeFileSync(join(dir, ".dev.vars.example"), `SIGNING_KEY=${FAKE_AWS_KEY}\n`);
  writeFileSync(join(dir, "app.js"), "export const ok = true;\n");

  const { files } = collectFiles(dir);

  assert.ok(!files.some((file) => file.endsWith(".example")));
  assert.deepEqual(scanDirectory(dir).findings, []);
});

test("scanning a directory reports the file path relative to the root", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-secrets-"));

  writeFileSync(join(dir, "leaky.js"), `const k = "${FAKE_AWS_KEY}";\n`);

  const { findings, scanned } = scanDirectory(dir);

  assert.equal(scanned, 1);
  assert.equal(findings[0].path, "leaky.js");
});

test("toLineColumn is one-based on both axes", () => {
  assert.deepEqual(toLineColumn("abc", 0), { line: 1, column: 1 });
  assert.deepEqual(toLineColumn("ab\ncd", 3), { line: 2, column: 1 });
});
