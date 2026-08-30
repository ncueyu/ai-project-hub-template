/**
 * 後台分頁的結構不變式（2026-08-30 階段 E）。
 *
 * 為什麼需要這一支：後台在密碼閘道後面，而 `AGENTS.md` 第 6 節規定密碼不
 * 經過 AI，所以開發時沒辦法用瀏覽器點過去看。分頁最容易壞的地方剛好都是
 * 靜態可檢查的——標籤與面板對不上、初始狀態多開一個面板、或是踩到那個
 * 已經踩過五次的 `hidden` 坑。這些用測試釘住，剩下的互動由使用者驗收。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(PROJECT_ROOT, "public/admin/index.html"), "utf8");
const CSS = readFileSync(join(PROJECT_ROOT, "public/admin/admin.css"), "utf8");
const JS = readFileSync(join(PROJECT_ROOT, "public/admin/admin.js"), "utf8");

/** @returns {{ id: string, controls: string, selected: string, hidden: boolean }[]} */
function readTabs() {
  return [...HTML.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((match) => {
    const tag = match[0];

    return {
      id: /id="([^"]+)"/.exec(tag)?.[1] ?? "",
      controls: /aria-controls="([^"]+)"/.exec(tag)?.[1] ?? "",
      selected: /aria-selected="([^"]+)"/.exec(tag)?.[1] ?? "",
      hidden: false,
    };
  });
}

/** @returns {{ id: string, labelledby: string, hidden: boolean }[]} */
function readPanels() {
  return [...HTML.matchAll(/<div class="admin-panel"[^>]*>/g)].map((match) => {
    const tag = match[0];

    return {
      id: /id="([^"]+)"/.exec(tag)?.[1] ?? "",
      labelledby: /aria-labelledby="([^"]+)"/.exec(tag)?.[1] ?? "",
      hidden: / hidden(?=[ >])/.test(tag),
    };
  });
}

test("四個分頁與四個面板一一對應，aria 關聯兩邊都指得回去", () => {
  const tabs = readTabs();
  const panels = readPanels();

  assert.equal(tabs.length, 4, "分頁數量");
  assert.equal(panels.length, 4, "面板數量");

  for (const tab of tabs) {
    const panel = panels.find((item) => item.id === tab.controls);

    assert.ok(panel, `分頁 ${tab.id} 的 aria-controls 指向不存在的面板`);
    assert.equal(panel.labelledby, tab.id, `面板 ${panel.id} 的 aria-labelledby 沒有指回分頁`);
  }
});

test("初始狀態只有一個面板是開的，而且就是 aria-selected 的那一個", () => {
  const tabs = readTabs();
  const panels = readPanels();

  const visible = panels.filter((panel) => !panel.hidden);
  assert.equal(visible.length, 1, "初始只能有一個面板可見");

  const selected = tabs.filter((tab) => tab.selected === "true");
  assert.equal(selected.length, 1, "初始只能有一個分頁是 aria-selected");
  assert.equal(selected[0].controls, visible[0].id, "被選取的分頁要對應到那個可見面板");
});

test("面板不能自己宣告 display——那會讓 hidden 失效（本專案踩過五次的坑）", () => {
  /*
   * `hidden` 的效果來自 UA 樣式表的 `[hidden] { display: none }`，而作者
   * 樣式表的任何類別選擇器都勝過 UA 樣式表。`.admin-panel` 只要設了 display，
   * 三個分頁就會同時出現——而且不會有任何錯誤訊息。
   */
  const rule = /\.admin-panel\s*\{([^}]*)\}/.exec(CSS);

  if (rule) {
    assert.ok(!/display\s*:/.test(rule[1]), ".admin-panel 不該宣告 display");
  }

  assert.match(
    CSS,
    /\.admin-panel\[hidden\]\s*\{[^}]*display\s*:\s*none/,
    "必須有明確的 .admin-panel[hidden] { display: none } 當保險",
  );
});

test("切換分頁用 hidden 屬性，不是用 class 控制顯示", () => {
  // 用 class 控制的話就繞回上面那個坑了。
  assert.match(JS, /panel\.hidden\s*=/, "應該直接設 panel.hidden");
});

test("四個分頁的 hash 可以直接連過去，AGENTS.md 才能給連結", () => {
  for (const hash of ["projects", "taxonomy", "links", "settings"]) {
    assert.ok(JS.includes(`hash: "${hash}"`), `缺少 hash：${hash}`);
  }

  assert.match(JS, /location\.hash/, "載入時要讀 hash");
  assert.match(JS, /hashchange/, "hash 改變時要跟著切換");
});

test("未選取的分頁移出 Tab 鍵順序，並支援左右鍵切換", () => {
  assert.match(JS, /tabIndex = isActive \? 0 : -1/, "未選取的分頁要 tabindex=-1");
  assert.match(JS, /ArrowRight/, "要支援右方向鍵");
  assert.match(JS, /ArrowLeft/, "要支援左方向鍵");
});
