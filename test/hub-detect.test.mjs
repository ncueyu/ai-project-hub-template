import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectProject } from "../tools/detect.mjs";
import { planBuild } from "../tools/build-plan.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "detect");

/**
 * @param {string} name
 */
function fixture(name) {
  return join(FIXTURES, name);
}

test("each of the seven project kinds is detected from its own fixture", () => {
  const expectations = [
    ["plain-html", "static"],
    ["vite", "vite"],
    ["react", "react"],
    ["vue", "vue"],
    ["nextjs", "nextjs"],
    ["worker", "worker"],
    ["node-api", "node-api"],
  ];

  for (const [name, expected] of expectations) {
    assert.equal(detectProject(fixture(name)).kind, expected, `${name} 應判為 ${expected}`);
  }
});

test("detection order resolves projects that match more than one rule", () => {
  // worker fixture 同時含有 react 相依套件：部署方式由 wrangler 決定，
  // 因此必須判為 worker 而不是 react。
  const worker = detectProject(fixture("worker"));

  assert.equal(worker.kind, "worker");
  assert.ok(worker.evidence.some((item) => item.includes("wrangler")));

  // Next.js 一定含有 react，必須判為 nextjs。
  assert.equal(detectProject(fixture("nextjs")).kind, "nextjs");

  // vue fixture 同時含有 vite，框架優先於打包工具。
  const vue = detectProject(fixture("vue"));

  assert.equal(vue.kind, "vue");
  assert.equal(vue.bundler, "vite");
});

test("detection reports the evidence it used", () => {
  const detection = detectProject(fixture("react"));

  assert.ok(detection.evidence.length > 0);
  assert.ok(detection.evidence.some((item) => item.includes("react")));
});

test("a project with no recognisable signal is reported as unknown, not guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-detect-"));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "make" } }));

  assert.equal(detectProject(dir).kind, "unknown");
});

test("package manager comes from the lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-detect-"));

  writeFileSync(join(dir, "package.json"), "{}");
  assert.equal(detectProject(dir).packageManager, "npm");

  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  assert.equal(detectProject(dir).packageManager, "pnpm");
});

test("build plans match the detected kind field by field", () => {
  const expectations = [
    ["plain-html", { kind: "static", command: null, output: ".", platform: "cloudflare" }],
    ["vite", { kind: "vite", command: "npm run build", output: "dist", platform: "cloudflare" }],
    ["react", { kind: "react", command: "npm run build", output: "dist", platform: "cloudflare" }],
    ["vue", { kind: "vue", command: "npm run build", output: "dist", platform: "cloudflare" }],
    ["nextjs", { kind: "nextjs", command: "npm run build", output: ".next", platform: "vercel" }],
    ["worker", { kind: "worker", command: null, output: null, platform: "cloudflare" }],
    ["node-api", { kind: "node-api", command: null, output: null, platform: "vercel" }],
  ];

  for (const [name, expected] of expectations) {
    const plan = planBuild(fixture(name));

    for (const [field, value] of Object.entries(expected)) {
      assert.equal(plan[field], value, `${name} 的 ${field} 應為 ${value}`);
    }
  }
});

test("a project that needs a build but has no build script is blocked, not silently skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-detect-"));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { vue: "^3.5.0" } }));

  const plan = planBuild(dir);

  assert.equal(plan.kind, "vue");
  assert.equal(plan.command, null);
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0], /build/);
});

test("an unknown kind blocks planning instead of picking a default", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-detect-"));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "make" } }));

  const plan = planBuild(dir);

  assert.equal(plan.kind, "unknown");
  assert.equal(plan.platform, null);
  assert.ok(plan.blockers.length > 0);
});

test("the pnpm build command goes through corepack because pnpm is not on PATH here", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-detect-"));

  writeFileSync(join(dir, "package.json"), JSON.stringify({
    scripts: { build: "vite build" },
    dependencies: { vue: "^3.5.0" },
  }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  assert.equal(planBuild(dir).command, "corepack pnpm run build");
});
