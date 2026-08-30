#!/usr/bin/env node
// @ts-check

/**
 * 階段二端對端整合驗證。
 *
 * 這支腳本會實際啟動 wrangler dev、對真實的本機 D1 與 R2 發送 HTTP 請求，
 * 驗證整條路徑真的能運作——單元測試用的假資料庫無法證明 SQL 跑不跑得起來。
 *
 * 執行前會自動把本機資料庫重置為 seed 狀態，因此可重複執行。
 *
 * 執行：pnpm run integration:stage2
 */

import { execFileSync, spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.STAGE2_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;

/** @type {{ ok: boolean, label: string, detail: string }[]} */
const results = [];

function check(ok, label, detail = "") {
  results.push({ ok: Boolean(ok), label, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` :: ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n${"-".repeat(58)}\n${title}\n${"-".repeat(58)}`);
}

async function api(method, urlPath, body, extraHeaders = {}) {
  const init = { method, headers: { "Sec-Fetch-Site": "same-origin", ...extraHeaders } };

  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE}${urlPath}`, init);
  const text = await response.text();

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 回應 */ }

  return { status: response.status, json, text, headers: response.headers };
}

// 重置資料庫，確保每次執行的起點一致。
console.log("重置本機資料庫…");
execFileSync(
  process.execPath,
  [
    path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
    "d1", "execute", "ai-project-hub-db", "--local",
    "--file", "scripts/seed-local-d1.sql",
  ],
  {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, XDG_CONFIG_HOME: path.join(process.env.TEMP ?? ".", "wrangler-config") },
  },
);

const child = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--port", String(PORT), "--ip", "127.0.0.1"],
  {
    cwd: ROOT,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(process.env.TEMP ?? ".", "wrangler-config") },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverOutput = "";
child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

try {
  let ready = false;

  for (let i = 0; i < 90; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const probe = await fetch(`${BASE}/api/health`);
      if (probe.ok) { ready = true; break; }
    } catch { /* 尚未啟動 */ }
  }

  if (!ready) {
    console.error("dev server 未能啟動");
    console.error(serverOutput.slice(-2500));
    process.exitCode = 1;
  } else {
    // -------------------------------------------------- 可見性
    section("Visibility 測試表");

    const gallery = await api("GET", "/api/gallery/projects");
    const items = gallery.json?.data?.items ?? [];
    const slugs = items.map((i) => i.slug);

    check(gallery.status === 200, "展示中心 API 回應正常", `status=${gallery.status}`);
    check(slugs.includes("resistor-color-code"), "A Public 出現在展示中心");
    check(!slugs.includes("exam-analysis"), "B Unlisted 不在展示中心");
    check(!slugs.includes("plc-handout"), "C Password 不在展示中心");
    check(!slugs.includes("personal-budget"), "D Private 不在展示中心");
    check(!slugs.includes("legacy-course-site"), "E Disabled 不在展示中心");
    check(slugs.includes("class-message-board"), "F Worker+D1 出現在展示中心");
    check(slugs.includes("club-signup"), "G Supabase 出現在展示中心");

    const forbidden = ["exam-analysis", "plc-handout", "personal-budget", "legacy-course-site",
      "段考成績分析表", "PLC 實習講義", "個人記帳工具", "舊版課程網站"];
    const leaked = forbidden.filter((token) => gallery.text.includes(token));
    check(leaked.length === 0, "非公開專案完全未洩漏", leaked.join(", ") || "無");

    const adminFields = ["repository_url", "worker_name", "password_hash", "visibility"];
    const leakedFields = adminFields.filter((f) => gallery.text.includes(f));
    check(leakedFields.length === 0, "展示中心不含管理欄位", leakedFields.join(", ") || "無");

    const bypass = await api("GET", "/api/gallery/projects?visibility=private");
    check(
      bypass.json?.data?.items?.length === items.length && !bypass.text.includes("personal-budget"),
      "無法用參數繞過公開過濾",
    );

    // -------------------------------------------------- 專案 CRUD
    section("Projects CRUD");

    const created = await api("POST", "/api/projects", {
      name: "整合測試專案", slug: "integration-test-project",
      visibility: "public", platform: "cloudflare", project_type: "static",
      description: "由整合測試建立", deployment_url: "https://integration.example.test",
    });
    const newId = created.json?.data?.id;
    check(created.status === 201, "建立專案 -> 201", `status=${created.status}`);
    check(created.json?.data?.name === "整合測試專案", "中文名稱正確往返");

    const fetched = await api("GET", `/api/projects/${newId}`);
    check(fetched.status === 200, "讀取專案 -> 200");

    const patched = await api("PATCH", `/api/projects/${newId}`, { name: "改過的名稱" });
    check(
      patched.json?.data?.name === "改過的名稱" && patched.json?.data?.slug === "integration-test-project",
      "PATCH 只改指定欄位",
    );

    const inGalleryNow = await api("GET", "/api/gallery/projects");
    check(
      inGalleryNow.json?.data?.items?.some((i) => i.id === newId),
      "新增的 public 專案立即出現在展示中心",
    );

    const hidden = await api("PATCH", `/api/projects/${newId}`, { visibility: "private" });
    const afterHide = await api("GET", "/api/gallery/projects");
    check(
      hidden.status === 200 && !afterHide.json?.data?.items?.some((i) => i.id === newId),
      "改為私人後立即從展示中心消失",
    );

    const duplicate = await api("POST", "/api/projects", {
      name: "重複", slug: "integration-test-project", visibility: "public", platform: "cloudflare",
    });
    check(duplicate.status === 409, "重複代稱 -> 409", `status=${duplicate.status}`);

    const injection = "'; DROP TABLE projects; --";
    const injected = await api("POST", "/api/projects", {
      name: injection, slug: "injection-probe", visibility: "public", platform: "cloudflare",
    });
    const stillAlive = await api("GET", "/api/projects");
    check(
      injected.status === 201 && injected.json?.data?.name === injection && stillAlive.status === 200,
      "SQL 注入內容僅作為文字儲存，資料表完好",
    );

    await api("DELETE", `/api/projects/${injected.json?.data?.id}`);
    const deleted = await api("DELETE", `/api/projects/${newId}`);
    const gone = await api("GET", `/api/projects/${newId}`);
    check(deleted.status === 204 && gone.status === 404, "刪除後查無該專案");

    // -------------------------------------------------- 圖片
    section("Thumbnail（R2 本機模擬）");

    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );

    const uploadForm = new FormData();
    uploadForm.append("file", new Blob([png], { type: "image/png" }), "photo.png");
    const uploaded = await fetch(`${BASE}/api/projects/1/thumbnail`, { method: "POST", body: uploadForm });
    const uploadedJson = await uploaded.json();
    const thumbUrl = uploadedJson?.data?.thumbnail_url ?? "";

    check(uploaded.status === 201, "上傳 PNG -> 201", `status=${uploaded.status}`);
    check(thumbUrl.startsWith("/media/thumbnails/") && !thumbUrl.includes("r2.dev"), "使用 Hub 媒體路徑", thumbUrl);

    const media = await fetch(`${BASE}${thumbUrl}`);
    check(media.status === 200 && media.headers.get("content-type") === "image/png", "讀取圖片並回傳正確類型");
    check(media.headers.get("x-content-type-options") === "nosniff", "帶 nosniff 標頭");

    const svgForm = new FormData();
    svgForm.append("file", new Blob([new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')], { type: "image/svg+xml" }), "evil.svg");
    const svgUpload = await fetch(`${BASE}/api/projects/1/thumbnail`, { method: "POST", body: svgForm });
    check(svgUpload.status === 415, "SVG 被拒絕", `status=${svgUpload.status}`);

    const fakeForm = new FormData();
    fakeForm.append("file", new Blob([new TextEncoder().encode("not an image at all")], { type: "image/png" }), "fake.png");
    const fakeUpload = await fetch(`${BASE}/api/projects/1/thumbnail`, { method: "POST", body: fakeForm });
    check(fakeUpload.status === 415, "偽造的 MIME 與副檔名被拒絕", `status=${fakeUpload.status}`);

    const traversal = await fetch(`${BASE}/media/thumbnails/..%2F..%2Fwrangler.jsonc`);
    check(traversal.status === 404, "讀取端擋下路徑穿越");

    // -------------------------------------------------- 政策版本
    section("Policy Version");

    const policyBefore = await api("GET", "/api/projects/4/policy");
    const versionBefore = policyBefore.json?.data?.policy_version;
    check(policyBefore.status === 200 && !policyBefore.text.includes("pbkdf2"), "政策回應不含密碼雜湊");

    // hub-ignore-secret：整合測試用的假密碼，刻意寫死才能驗證變更流程。
    const changed = await api("PUT", "/api/projects/4/policy", { password: "a-long-enough-password" });
    check(
      changed.json?.data?.policy_version === versionBefore + 1,
      "變更密碼會提高政策版本",
      `${versionBefore} -> ${changed.json?.data?.policy_version}`,
    );

    await api("PATCH", "/api/projects/4", { description: "只改說明文字" });
    const policyAfterMetadata = await api("GET", "/api/projects/4/policy");
    check(
      policyAfterMetadata.json?.data?.policy_version === changed.json?.data?.policy_version,
      "改一般中繼資料不會提高政策版本",
    );

    const shortPassword = await api("PUT", "/api/projects/4/policy", { password: "short" });
    check(shortPassword.status === 400, "太短的密碼被拒絕");

    // -------------------------------------------------- 部署紀錄
    section("Deployment Metadata");

    for (const status of ["success", "failed", "rolled_back", "unknown"]) {
      const recorded = await api("POST", "/api/projects/1/deployments", {
        platform: "cloudflare",
        deployment_url: `https://deploy-${status}.example.test`,
        status,
      });
      check(recorded.status === 201, `可記錄 ${status} 狀態`);
      await new Promise((r) => setTimeout(r, 12));
    }

    const deployments = await api("GET", "/api/projects/1/deployments");
    const created_at = (deployments.json?.data?.items ?? []).map((d) => d.created_at);
    check(
      JSON.stringify(created_at) === JSON.stringify([...created_at].sort().reverse()),
      "部署紀錄依時間新到舊排序",
    );

    await api("POST", "/api/projects/1/deployments", {
      platform: "cloudflare", deployment_url: "https://good-deploy.example.test", status: "success",
    });
    await api("POST", "/api/projects/1/deployments", {
      platform: "cloudflare", deployment_url: "https://bad-deploy.example.test", status: "failed",
    });
    const projectAfter = await api("GET", "/api/projects/1");
    check(
      projectAfter.json?.data?.deployment_url === "https://good-deploy.example.test",
      "失敗紀錄不覆蓋最後成功的網址",
      projectAfter.json?.data?.deployment_url,
    );

    // -------------------------------------------------- 安全防護
    section("跨站與方法防護");

    for (const [label, urlPath, method] of [
      ["建立專案", "/api/projects", "POST"],
      ["設定密碼", "/api/projects/1/policy", "PUT"],
      ["新增部署紀錄", "/api/projects/1/deployments", "POST"],
    ]) {
      const response = await fetch(`${BASE}${urlPath}`, {
        method,
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
        body: "{}",
      });
      check(response.status === 403, `跨站${label}被拒絕`, `status=${response.status}`);
    }

    const galleryWrite = await fetch(`${BASE}/api/gallery/projects`, { method: "POST" });
    check(galleryWrite.status === 405, "展示中心 API 為唯讀", `status=${galleryWrite.status}`);

    const unknownApi = await api("GET", "/api/unknown-resource");
    check(unknownApi.status === 404, "未知的 API 資源回 404");

    // -------------------------------------------------- 靜態頁面
    section("靜態頁面");

    for (const [label, urlPath] of [
      ["展示中心首頁", "/"],
      ["管理後台", "/admin/"],
    ]) {
      const page = await fetch(`${BASE}${urlPath}`);
      check(page.status === 200, `${label}可正常開啟`, `status=${page.status}`);
    }

    const home = await fetch(`${BASE}/`);
    const homeHtml = await home.text();
    check(!forbidden.some((t) => homeHtml.includes(t)), "首頁 HTML 不夾帶非公開專案資料");
    check(!homeHtml.includes("fonts.googleapis.com"), "首頁不載入外部字型");
  }
} finally {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { /* 已結束 */ }
  await new Promise((resolve) => setTimeout(resolve, 1500));

  let stillRunning = false;
  try {
    process.kill(child.pid, 0);
    stillRunning = true;
  } catch { /* 已停止 */ }

  console.log(`\ndev server ${stillRunning ? `仍在執行（PID ${child.pid}）` : "已停止"}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"=".repeat(58)}`);
  console.log(`TOTAL=${results.length} PASS=${results.length - failed.length} FAIL=${failed.length}`);

  if (failed.length > 0) {
    console.log("FAILED:");
    for (const item of failed) {
      console.log(`  - ${item.label}${item.detail ? ` :: ${item.detail}` : ""}`);
    }
    process.exitCode = 1;
  }
}
