import { topicChips } from "../src/topic-chips";

describe("topicChips", () => {
  test("offers each topic and each of its parent prefixes", () => {
    expect(topicChips(["acme/billing/invoices"])).toEqual([
      "acme",
      "acme/billing",
      "acme/billing/invoices",
    ]);
  });

  test("deduplicates and sorts topics from every source", () => {
    expect(
      topicChips(["beta", "acme/billing", "acme", "acmecorp", "beta", "acme/billing"]),
    ).toEqual(["acme", "acme/billing", "acmecorp", "beta"]);
  });

  test("offers no chip for an empty prefix", () => {
    expect(topicChips(["/a", "b//c", "d/"])).toEqual(["/a", "b", "b/", "b//c", "d", "d/"]);
  });

  test("offers nothing for no topics", () => {
    expect(topicChips([])).toEqual([]);
  });
});
