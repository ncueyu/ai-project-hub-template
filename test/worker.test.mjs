import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

function createAssetsBinding() {
  return {
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/admin/index.html") {
        return new Response("admin-shell", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(`asset:${url.pathname}`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    },
  };
}

function request(path, init) {
  return new Request(`https://hub.example.test${path}`, init);
}

test("GET /api/health returns the exact skeleton health contract", async () => {
  const response = await worker.fetch(request("/api/health"), {
    ASSETS: createAssetsBinding(),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("non-read methods are rejected by /api/health", async () => {
  const response = await worker.fetch(request("/api/health", { method: "POST" }), {
    ASSETS: createAssetsBinding(),
  });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("public static routes defer to the asset binding", async () => {
  for (const path of ["/styles.css"]) {
    const response = await worker.fetch(request(path), {
      ASSETS: createAssetsBinding(),
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), `asset:${path}`);
  }
});

test("admin routes require the admin flag before reaching assets", async () => {
  // 管理介面預設關閉，因此不再無條件交給靜態資源處理。
  // 完整的開關行為由 test/admin-gate.test.mjs 涵蓋。
  const closed = await worker.fetch(request("/admin/"), {
    ASSETS: createAssetsBinding(),
  });

  assert.equal(closed.status, 404);
});

test("an open but unauthenticated admin route does not fall through to assets", async () => {
  // 2026-08-25 起「開啟」不再等於「直接放行給靜態資源」——中間多了
  // `src/admin-gate.js` 的登入閘道（取代原計畫的 Cloudflare Access）。
  // 完整的登入閘道行為由 test/admin-gate.test.mjs 涵蓋，這裡只確認
  // 沒有退回舊行為（未登入卻直接拿到資產內容），防止日後改壞了沒人發現。
  const response = await worker.fetch(
    request("/admin/", { headers: { "Sec-Fetch-Dest": "document" } }),
    { ADMIN_ENABLED: "true", ASSETS: createAssetsBinding() },
  );

  assert.notEqual(await response.text(), "asset:/admin/");
});
