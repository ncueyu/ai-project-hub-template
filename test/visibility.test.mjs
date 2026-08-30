import assert from "node:assert/strict";
import test from "node:test";

import {
  GALLERY_LISTED_STATES,
  VISIBILITY_STATES,
  describeVisibility,
  isDirectlyReachable,
  isListedInGallery,
  isValidVisibility,
  requiresAccessGate,
  requiresPasswordToOpen,
  runWorkerFirstFor,
} from "../src/visibility.js";

test("exactly five visibility states exist", () => {
  assert.deepEqual([...VISIBILITY_STATES], ["public", "unlisted", "password", "private", "disabled"]);
});

test("public and password are listed in the gallery", () => {
  // password 也列出是刻意的（2026-08-23 裁定）：不列出的話沒有人知道它存在。
  assert.deepEqual([...GALLERY_LISTED_STATES], ["public", "password"]);

  assert.equal(isListedInGallery("public"), true);
  assert.equal(isListedInGallery("password"), true);

  for (const state of ["unlisted", "private", "disabled"]) {
    assert.equal(isListedInGallery(state), false, state);
  }
});

test("only password is marked as needing a password", () => {
  assert.equal(requiresPasswordToOpen("password"), true);

  for (const state of ["public", "unlisted", "private", "disabled"]) {
    assert.equal(requiresPasswordToOpen(state), false, state);
  }
});

test("every listed state is either open or password-marked", () => {
  // 列出的專案訪客一定會看到，所以它要嘛真的打得開，要嘛必須標示需要密碼。
  // 少了這條，未來若把 private 誤加進列出清單，訪客會看到一張點了就 404 的卡片。
  for (const state of GALLERY_LISTED_STATES) {
    assert.equal(
      isDirectlyReachable(state) || requiresPasswordToOpen(state),
      true,
      `${state} 列在展示中心，卻既打不開也沒標示需要密碼`,
    );
  }
});

test("public and unlisted are reachable with a direct link", () => {
  assert.equal(isDirectlyReachable("public"), true);
  assert.equal(isDirectlyReachable("unlisted"), true);

  for (const state of ["password", "private", "disabled"]) {
    assert.equal(isDirectlyReachable(state), false, state);
  }
});

test("unlisted needs no access gate", () => {
  // 這是 TASK-2.8 的核心：unlisted 只是不列出，不是受保護。
  // 若誤加閘道，靜態請求會從免費無上限變成計費請求。
  assert.equal(requiresAccessGate("unlisted"), false);
  assert.deepEqual(runWorkerFirstFor("unlisted"), []);
});

test("public needs no access gate either", () => {
  assert.equal(requiresAccessGate("public"), false);
  assert.deepEqual(runWorkerFirstFor("public"), []);
});

test("password, private and disabled all require a gate covering every path", () => {
  for (const state of ["password", "private", "disabled"]) {
    assert.equal(requiresAccessGate(state), true, state);
    assert.deepEqual(runWorkerFirstFor(state), ["/*"], state);
  }
});

test("the gate covers all paths so sub-resources cannot bypass it", () => {
  // 只保護 HTML 而不保護 /app.js 之類的子資源，等於沒有保護。
  assert.deepEqual(runWorkerFirstFor("private"), ["/*"]);
});

test("listed and directly reachable are independent axes", () => {
  // 2026-08-23 之前這裡斷言「列出 ⟹ 可直接開啟」。那條不變式已被規格推翻：
  // password 現在會列出卻打不開。兩個軸從此各自獨立，四種組合都有實例——
  // 這正是 visibility.js 檔頭堅持「三個問題分開問」的原因。
  assert.equal(isListedInGallery("public"), true);
  assert.equal(isDirectlyReachable("public"), true);

  // 列出但打不開：加密專案。
  assert.equal(isListedInGallery("password"), true);
  assert.equal(isDirectlyReachable("password"), false);

  // 打得開但不列出：unlisted 的用途就是「不宣傳」。
  assert.equal(isDirectlyReachable("unlisted"), true);
  assert.equal(isListedInGallery("unlisted"), false);

  // 兩者皆非。
  assert.equal(isListedInGallery("private"), false);
  assert.equal(isDirectlyReachable("private"), false);
});

test("gated states are never directly reachable", () => {
  for (const state of VISIBILITY_STATES) {
    if (requiresAccessGate(state)) {
      assert.equal(isDirectlyReachable(state), false, `${state} 需要閘道就不該直接可達`);
    }
  }
});

test("validation accepts only the five known states", () => {
  for (const state of VISIBILITY_STATES) {
    assert.equal(isValidVisibility(state), true, state);
  }

  for (const bad of ["", "PUBLIC", "hidden", "draft", "unknown"]) {
    assert.equal(isValidVisibility(bad), false, bad);
  }
});

test("describeVisibility summarises all three questions at once", () => {
  assert.deepEqual(describeVisibility("public"), { listed: true, directLink: true, gated: false });
  assert.deepEqual(describeVisibility("unlisted"), { listed: false, directLink: true, gated: false });
  // password 是唯一「列出卻打不開」的狀態，所以它也是唯一需要標記的。
  assert.deepEqual(describeVisibility("password"), { listed: true, directLink: false, gated: true });
  assert.deepEqual(describeVisibility("private"), { listed: false, directLink: false, gated: true });
  assert.deepEqual(describeVisibility("disabled"), { listed: false, directLink: false, gated: true });
});
