/**
 * 後台的「顯示順序」欄位與分類篩選（2026-09-06）。
 *
 * 這幾條釘的都是「壞掉也不會有錯誤訊息」的東西：
 *   - 序號欄位不見了 → 管理者只是找不到，不會有人報錯
 *   - 「填 1 = 主卡片」的說明不見了 → 他把某張排到第一位，它突然套上主卡樣式，
 *     畫面上沒有任何線索解釋為什麼
 *   - 篩選容器不見了 → 專案一多就回到「一長條看不出誰是誰」
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "public/admin/index.html"), "utf8");
const js = readFileSync(resolve(ROOT, "public/admin/admin.js"), "utf8");
const css = readFileSync(resolve(ROOT, "public/admin/admin.css"), "utf8");

test("專案表單有顯示順序欄位，而且是不接受負數的數字輸入", () => {
  const field = html.match(/<input[^>]*id="project-sort-order"[^>]*>/);

  assert.ok(field, "找不到 id=project-sort-order 的輸入欄位");
  assert.match(field[0], /type="number"/, "要用 number 型態，手機才會跳數字鍵盤");
  assert.match(field[0], /min="0"/, "不接受負數——0 是「尚未指定」的中性值，負數沒有語意");
  assert.match(field[0], /name="sort_order"/, "name 要跟 API 欄位一致，FormData 才讀得到");
});

test("欄位旁邊講明「填 1 = 主卡片」——這是既有的隱藏規則，不講就沒人知道", () => {
  // 判定主卡片的方式一直都是 sort_order === 1（src/repositories/gallery.js）。
  // 這條檢查確保那個規則在管理者看得到的地方被寫出來。
  assert.match(html, /填 1 就是主卡片/);
});

test("欄位說明講出 0 的行為——0 最小，會排在已編號的專案前面", () => {
  /*
   * 這是使用者第一次用這個欄位幾乎必定會撞到的事：把某張設成 1，
   * 卻發現它沒排到第一（因為還有一堆 0）。畫面上沒有任何線索解釋原因。
   */
  assert.match(html, /還沒編號的專案是/);
  assert.match(html, /前面/);
});

test("「設為主卡片」按鈕講明它會重新編號其他專案", () => {
  // setPrimaryProject() 會把其餘專案重編成 2,3,4…，刻意留的間隔會被壓平。
  const button = html.match(/<button[^>]*project-set-primary[\s\S]*?<\/button>/);

  assert.ok(button, "找不到設為主卡片按鈕");
  assert.match(button[0], /重新編號/, "按鈕要標明副作用");
});

test("有分類篩選容器，而且 CSS 補了 [hidden] 覆寫", () => {
  assert.match(html, /id="project-filter"/, "找不到分類篩選容器");

  // .admin-filter 設了 display: flex，HTML 上帶 hidden。
  // 沒有這條覆寫的話 hidden 完全失效——本專案踩過五次的坑。
  assert.match(css, /\.admin-filter\[hidden\]\s*\{[^}]*display:\s*none/);
});

test("分類篩選存的是 id 不是名稱", () => {
  // 分類可以改名。用名稱比對會在改名之後安靜地篩不到東西。
  assert.match(js, /categoryFilter/, "state 要有 categoryFilter");
  assert.match(js, /project\.category_id === state\.categoryFilter/);
});

test("新增專案時序號欄位停用——送出後會被忽略的欄位不該可輸入", () => {
  assert.match(js, /projectSortOrderInput\.disabled = !editing/);
});
