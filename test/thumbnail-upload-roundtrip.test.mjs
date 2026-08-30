/**
 * 後台「上傳圖片」按鈕的整條路徑（2026-08-30）。
 *
 * ## 為什麼要有這一份，既然 thumbnail-upload.test.mjs 已經存在
 *
 * 那一份只測了「哪些縮圖網址算是自己存的」與允許的檔案類型——都是純函式。
 * `handleThumbnailUpload()` 本身**從來沒有被真的呼叫過**：它在管理 API 後面，
 * 要後台密碼，而 `AGENTS.md` 第 6 節規定密碼不經過 AI，所以階段 3 交付時
 * 誠實標註了「上傳這個動作本身沒有端到端跑過」。
 *
 * 那個缺口正是這個專案一直在防的形狀：一段看起來正確、有測試環繞、
 * 但沒有任何測試真的執行過的程式碼（`installThumbnail()` 就是這樣躺了兩週）。
 *
 * 這裡補上的是「按下按鈕之後」的完整鏈路，只差瀏覽器與登入：
 *   真的 multipart Request → handleThumbnailUpload → D1 → handleThumbnailFetch
 *   → 位元組與原檔逐一比對
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleThumbnailFetch, handleThumbnailUpload } from "../src/routes/thumbnails.js";

/**
 * 一張合法的 2x2 PNG。用真的檔案位元組而不是隨手一段資料，因為
 * `detectImageType()` 看的就是檔頭特徵——假資料會在型別檢查那關就被擋掉，
 * 於是測試變成在測「錯誤路徑」，而不是我們想確認的快樂路徑。
 */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVQI12P8z8Dwn4"
    + "GBgYmBgYGBgQEAHgwD/0YAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

/**
 * 假 D1，實作這條路徑真的會用到的四種查詢。
 *
 * 與 `test/thumbnail-blobs.test.mjs` 的版本不同之處：這裡還要有 `projects`，
 * 因為上傳成功後要把 `thumbnail_url` 指過去——那一步失敗的話，圖存進去了
 * 但卡片還是空的，而且前端不會有任何錯誤。
 */
function createFakeDb(project = { id: 1, thumbnail_url: null }) {
  const blobs = new Map();
  let chunks = [];
  const projects = new Map([[project.id, { ...project }]]);

  const run = (sql, params) => {
    if (sql.includes("FROM projects")) {
      const row = projects.get(params[0]);

      /*
       * **一定要回傳複本。** 真的 D1 每次 `.first()` 都給一個新的物件；
       * 回傳活的參照會讓後面的 UPDATE 連帶改到呼叫端手上那份，於是
       * `handleThumbnailUpload()` 讀到的「舊縮圖網址」變成新的那個，
       * 孤兒清理就被跳過了——而測試會顯示成「清理沒作用」，
       * 讓人跑去改正確的產品程式碼。（第一版就是這樣紅的。）
       */
      return { first: row ? { ...row } : null };
    }

    if (sql.includes("UPDATE projects")) {
      const [thumbnail_url, updated_at, id] = params;
      const row = projects.get(id);

      if (row) {
        Object.assign(row, { thumbnail_url, updated_at });
      }

      return { results: [] };
    }

    if (sql.includes("INSERT INTO thumbnail_blobs")) {
      const [object_key, content_type, byte_size, chunk_count] = params;

      blobs.set(object_key, { content_type, byte_size, chunk_count });
      return { results: [] };
    }

    if (sql.includes("DELETE FROM thumbnail_chunks")) {
      chunks = chunks.filter((chunk) => chunk.key !== params[0]);
      return { results: [] };
    }

    if (sql.includes("DELETE FROM thumbnail_blobs")) {
      blobs.delete(params[0]);
      return { results: [] };
    }

    if (sql.includes("INSERT INTO thumbnail_chunks")) {
      chunks.push({ key: params[0], seq: params[1], data: params[2] });
      return { results: [] };
    }

    if (sql.includes("FROM thumbnail_blobs")) {
      return { first: blobs.get(params[0]) ?? null };
    }

    if (sql.includes("FROM thumbnail_chunks")) {
      return {
        results: chunks
          .filter((chunk) => chunk.key === params[0])
          .sort((a, b) => a.seq - b.seq)
          .map((chunk) => ({ data: chunk.data })),
      };
    }

    throw new Error(`假資料庫沒有處理這句 SQL：${sql}`);
  };

  return {
    projects,
    blobs,
    getChunks: () => chunks,
    prepare(sql) {
      let bound = [];

      return {
        bind(...params) {
          bound = params;
          return this;
        },
        async first() {
          return run(sql, bound).first ?? null;
        },
        async all() {
          return { results: run(sql, bound).results ?? [] };
        },
        async run() {
          return run(sql, bound);
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        await statement.run();
      }

      return statements.map(() => ({ results: [] }));
    },
  };
}

/**
 * 組一個和瀏覽器送出來的一樣的請求。
 *
 * 用 FormData 而不是自己拼 multipart 字串：邊界字串、CRLF、結尾 `--` 手寫
 * 很容易出錯，而寫錯的話測的就是我的拼字能力，不是這條路徑。
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 */
function makeUploadRequest(bytes, filename = "screenshot.png", type = "image/png") {
  const form = new FormData();

  form.append("file", new Blob([bytes], { type }), filename);

  return new Request("https://hub.example/api/projects/1/thumbnail", {
    method: "POST",
    headers: { "Sec-Fetch-Site": "same-origin" },
    body: form,
  });
}

test("上傳一張 PNG：201、專案指向新網址、位元組原封不動讀得回來", async () => {
  const db = createFakeDb();

  const response = await handleThumbnailUpload(makeUploadRequest(PNG), db, {}, 1);

  assert.equal(response.status, 201, await response.clone().text());

  const body = await response.json();
  const thumbnailUrl = body.data.thumbnail_url;

  // 網址形狀要能被 parseOwnThumbnailKey() 認得，否則之後換圖時清不掉舊的位元組。
  assert.match(thumbnailUrl, /^\/media\/thumbnails\/[0-9a-f-]{36}\.png$/);

  // 圖存進去了，但專案沒指過去的話，卡片還是空的——而且前端不會有任何錯誤。
  assert.equal(db.projects.get(1).thumbnail_url, thumbnailUrl);

  // 真正的驗收：從讀取路由拿回來的位元組要與原檔完全相同。
  const key = thumbnailUrl.slice("/media/thumbnails/".length);
  const fetched = await handleThumbnailFetch(
    new Request(`https://hub.example${thumbnailUrl}`),
    { DB: db },
    [key],
  );

  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("Content-Type"), "image/png");
  assert.equal(fetched.headers.get("Content-Length"), String(PNG.length));
  assert.equal(fetched.headers.get("X-Content-Type-Options"), "nosniff");

  const returned = new Uint8Array(await fetched.arrayBuffer());

  assert.deepEqual(returned, PNG, "讀回來的位元組必須與原檔完全相同");
});

test("換圖時舊的位元組會被刪掉，不留孤兒", async () => {
  /*
   * 每次上傳都產生新的 UUID，所以舊圖不會被覆蓋而是變成沒有人指向的孤兒。
   * 換十次圖就有九份，而 D1 免費方案單一資料庫上限 500 MB——
   * 這件事在前端完全看不出來，只會慢慢吃掉配額。
   */
  const db = createFakeDb();

  const first = await (await handleThumbnailUpload(makeUploadRequest(PNG), db, {}, 1)).json();

  assert.equal(db.blobs.size, 1);

  const second = await (await handleThumbnailUpload(makeUploadRequest(PNG), db, {}, 1)).json();

  assert.notEqual(first.data.thumbnail_url, second.data.thumbnail_url);
  assert.equal(db.blobs.size, 1, "換圖之後只該剩下新的那一份");
  assert.ok(
    db.getChunks().every((chunk) => second.data.thumbnail_url.endsWith(chunk.key)),
    "舊圖的段落必須一起被清掉",
  );
});

test("使用者手動填的外部網址不會被當成孤兒刪掉", async () => {
  // 舊制的 /thumbnails/xxx.png 靜態檔與外部網址都不是這個路由存的，
  // 去刪只會刪錯或刪不到，而且不會有人發現。
  const db = createFakeDb({ id: 1, thumbnail_url: "https://example.com/someone-elses.png" });

  const response = await handleThumbnailUpload(makeUploadRequest(PNG), db, {}, 1);

  assert.equal(response.status, 201);
  assert.equal(db.blobs.size, 1);
});

test("不是圖片的檔案被擋下，而且訊息說得出使用者能做什麼", async () => {
  const db = createFakeDb();
  const notAnImage = new TextEncoder().encode("<html>這其實是網頁</html>");

  // 副檔名與瀏覽器宣告的類型都不採信，只看檔案本身的位元組特徵。
  const response = await handleThumbnailUpload(
    makeUploadRequest(notAnImage, "假裝是圖.png"),
    db,
    {},
    1,
  );

  assert.equal(response.status, 415);
  assert.equal(db.blobs.size, 0, "被擋下時不該留下任何位元組");
  assert.equal(db.projects.get(1).thumbnail_url, null);

  const body = await response.json();

  assert.match(body.error.fields.file, /PNG/);
});

test("超過 1 MB 的圖被擋下，訊息告訴使用者怎麼縮小", async () => {
  const db = createFakeDb();
  const huge = new Uint8Array(1024 * 1024 + 1);

  huge.set(PNG, 0);

  const response = await handleThumbnailUpload(makeUploadRequest(huge), db, {}, 1);

  assert.equal(response.status, 413);
  assert.equal(db.blobs.size, 0);

  const body = await response.json();

  // 「檔案太大」對不懂技術的人不構成可執行的下一步。
  assert.match(body.error.fields.file, /小畫家/);
});

test("找不到專案時回 404，不會先把圖存進去", async () => {
  const db = createFakeDb();

  const response = await handleThumbnailUpload(makeUploadRequest(PNG), db, {}, 999);

  assert.equal(response.status, 404);
  assert.equal(db.blobs.size, 0);
});

test("跨站請求被擋下", async () => {
  const db = createFakeDb();
  const form = new FormData();

  form.append("file", new Blob([PNG], { type: "image/png" }), "x.png");

  const response = await handleThumbnailUpload(
    new Request("https://hub.example/api/projects/1/thumbnail", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
      body: form,
    }),
    db,
    {},
    1,
  );

  assert.equal(response.status, 403);
  assert.equal(db.blobs.size, 0);
});
