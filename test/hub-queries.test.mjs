import assert from "node:assert/strict";
import test from "node:test";

import { extractJson, sqlLiteral } from "../tools/d1.mjs";
import {
  DEPLOYMENT_COLUMNS,
  PROJECT_COLUMNS,
  assertLimit,
  assertProjectId,
  assertSlug,
  assertVisibility,
  buildDeploymentStatusSql,
  buildGetProjectSql,
  buildIdentifierCondition,
  buildListProjectsSql,
} from "../tools/queries.mjs";

test("no query ever selects the policies table or a wildcard", () => {
  const statements = [
    buildListProjectsSql(),
    buildListProjectsSql({ visibility: "public", limit: 5 }),
    buildGetProjectSql("my-project"),
    buildGetProjectSql(7),
    buildDeploymentStatusSql("my-project"),
  ];

  for (const sql of statements) {
    assert.ok(!sql.includes("*"), `不可使用 SELECT *：${sql}`);
    assert.ok(!sql.includes("project_policies"), `不可查詢 project_policies：${sql}`);
    assert.ok(!sql.toLowerCase().includes("password"), `不可出現 password：${sql}`);
  }
});

test("exposed columns are an explicit allow list", () => {
  assert.ok(PROJECT_COLUMNS.every((column) => column.startsWith("p.")));
  assert.ok(DEPLOYMENT_COLUMNS.every((column) => column.startsWith("d.")));
  assert.ok(!PROJECT_COLUMNS.some((column) => column.includes("password")));
});

test("numeric identifiers match on id and text identifiers match on slug", () => {
  assert.equal(buildIdentifierCondition(7), "p.id = 7");
  assert.equal(buildIdentifierCondition("7"), "p.id = 7");
  assert.equal(buildIdentifierCondition("my-project"), "p.slug = 'my-project'");
});

test("identifiers that are not valid slugs are rejected before reaching SQL", () => {
  // wrangler d1 execute 無法傳遞繫結參數，因此形狀驗證是第一道防線。
  const attacks = [
    "'; DROP TABLE projects; --",
    "my-project' OR '1'='1",
    "UPPERCASE",
    "with space",
    "a".repeat(81),
  ];

  for (const attack of attacks) {
    assert.throws(() => buildIdentifierCondition(attack), undefined, `應被拒絕：${attack}`);
  }
});

test("visibility filter only accepts the five known states", () => {
  assert.match(buildListProjectsSql({ visibility: "public" }), /p\.visibility = 'public'/);
  assert.throws(() => buildListProjectsSql({ visibility: "everyone" }));
  assert.throws(() => assertVisibility("public'; --"));
});

test("limit is bounded on both ends", () => {
  assert.equal(assertLimit(undefined), 50);
  assert.equal(assertLimit(1), 1);
  assert.equal(assertLimit(100), 100);
  assert.equal(assertLimit("25"), 25);

  for (const bad of [0, -1, 101, 1.5, "abc", {}]) {
    assert.throws(() => assertLimit(bad), undefined, `應被拒絕：${JSON.stringify(bad)}`);
  }
});

test("project ids must be positive integers", () => {
  assert.equal(assertProjectId(3), 3);
  assert.equal(assertProjectId("3"), 3);

  for (const bad of [0, -2, 1.5, "3; DROP TABLE projects", null]) {
    assert.throws(() => assertProjectId(bad));
  }
});

test("slug rule matches the documented pattern", () => {
  assert.equal(assertSlug("resistor-color-code"), "resistor-color-code");
  assert.throws(() => assertSlug("-leading"));
  assert.throws(() => assertSlug("trailing-"));
  assert.throws(() => assertSlug("double--dash"));
});

test("sqlLiteral escapes single quotes rather than dropping them", () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral(42), "42");
  assert.throws(() => sqlLiteral(1.5));
  assert.throws(() => sqlLiteral("has\u0000null"));
});

test("extractJson tolerates leading noise from wrangler", () => {
  const parsed = extractJson('⛅️ wrangler 4.120.0\n[{"results":[{"n":8}],"success":true}]');

  assert.equal(parsed[0].results[0].n, 8);
  assert.throws(() => extractJson("no json here"));
});

test("deployment status orders newest first and bounds the row count", () => {
  const sql = buildDeploymentStatusSql("my-project", { limit: 3 });

  assert.match(sql, /ORDER BY d\.created_at DESC/);
  assert.match(sql, /LIMIT 3/);
});
