import { expect, test } from "vitest";
import { tables as agents } from "../agents/schema";
import { tables as decisions } from "../decisions/schema";
import { tables as identity } from "../identity/schema";
import { tables as notifications } from "../notifications/schema";
import schema from "../schema";

// component-backend-foundation §Verification: every domain's tables appear in
// the composed schema exactly once.
test("the composed schema holds every domain table exactly once", () => {
  const domainTableNames = [agents, decisions, identity, notifications].flatMap((tables) =>
    Object.keys(tables),
  );
  const composed = Object.keys(schema.tables);

  expect(new Set(domainTableNames).size).toBe(domainTableNames.length);
  expect(composed.sort()).toEqual([...domainTableNames].sort());
  expect(composed).toContain("users");
});
