import {
  deepestSelectedLevel,
  hierarchyLabel,
  hierarchyPredicate,
  parseHierarchyPath,
  pickLevels,
} from "@/lib/hierarchy-path";
import { pathToParams } from "@/components/hierarchy-filter";

describe("hierarchyPredicate", () => {
  it("is unchanged for the four base levels", () => {
    expect(hierarchyPredicate({}, "s")).toEqual({ sql: "1=1", binds: [] });
    expect(hierarchyPredicate({ PRODUCT_NAME: "Ballantine's", CATEGORY_NAME: "Blended Scotch" }, "s")).toEqual({
      sql: "s.CATEGORY_NAME = ? AND s.PRODUCT_NAME = ?",
      binds: ["Blended Scotch", "Ballantine's"],
    });
  });

  it("filters an alternate level through its leaf on APP.V_SERIES, after the base levels", () => {
    expect(hierarchyPredicate({ REGION: "Europe", CHANNEL_NAME: "Off-trade" }, "d")).toEqual({
      sql: "d.CHANNEL_NAME = ? AND d.CUSTOMER_NAME IN (SELECT CUSTOMER_NAME FROM APP.V_SERIES WHERE REGION = ?)",
      binds: ["Off-trade", "Europe"],
    });
    expect(hierarchyPredicate({ PRODUCT_LINE: "Martell" }, "b").sql)
      .toBe("b.PRODUCT_NAME IN (SELECT PRODUCT_NAME FROM APP.V_SERIES WHERE PRODUCT_LINE = ?)");
    expect(hierarchyPredicate({ CHANNEL_GROUP: "Domestic" }, "v").sql)
      .toBe("v.CHANNEL_NAME IN (SELECT CHANNEL_NAME FROM APP.V_SERIES WHERE CHANNEL_GROUP = ?)");
  });

  it("never turns a roll-up into SQL", () => {
    expect(hierarchyPredicate({ ROLLUP_PRODUCT: "PRODUCT_FAMILY", ROLLUP_CUSTOMER: "CUSTOMER_REGION" }, "s"))
      .toEqual({ sql: "1=1", binds: [] });
  });
});

describe("parseHierarchyPath", () => {
  it("reads the base levels exactly as before", () => {
    expect(parseHierarchyPath(new URLSearchParams("CATEGORY_NAME=Cognac&PRODUCT_NAME=__all__&foo=bar")))
      .toEqual({ CATEGORY_NAME: "Cognac" });
  });

  it("reads alternate levels and known roll-ups, and ignores unknown or default ones", () => {
    expect(parseHierarchyPath(new URLSearchParams(
      "ROLLUP_CUSTOMER=CUSTOMER_REGION&REGION=Europe&ROLLUP_PRODUCT=BOGUS&ROLLUP_CHANNEL=CHANNEL_LIST",
    ))).toEqual({ REGION: "Europe", ROLLUP_CUSTOMER: "CUSTOMER_REGION" });
    expect(parseHierarchyPath(new URLSearchParams("ROLLUP_PRODUCT=CUSTOMER_REGION"))).toEqual({});
  });
});

describe("pickLevels", () => {
  it("keeps an alternate level when its leaf is allowed, and always keeps roll-ups", () => {
    const path = {
      CATEGORY_NAME: "Cognac",
      REGION: "Europe",
      PRODUCT_LINE: "Martell",
      CHANNEL_GROUP: "Domestic",
      ROLLUP_CUSTOMER: "CUSTOMER_REGION",
    };
    expect(pickLevels(path, ["CATEGORY_NAME", "CUSTOMER_NAME"])).toEqual({
      CATEGORY_NAME: "Cognac",
      REGION: "Europe",
      ROLLUP_CUSTOMER: "CUSTOMER_REGION",
    });
  });

  it("is unchanged for a base path", () => {
    expect(pickLevels({ CATEGORY_NAME: "Cognac", CHANNEL_NAME: "Off-trade" }, ["CATEGORY_NAME", "PRODUCT_NAME", "CUSTOMER_NAME"]))
      .toEqual({ CATEGORY_NAME: "Cognac" });
  });
});

describe("drill order helpers", () => {
  it("follow the roll-up's level order", () => {
    expect(deepestSelectedLevel({ CATEGORY_NAME: "Cognac", PRODUCT_NAME: "Martell VS" })).toBe("PRODUCT_NAME");
    expect(deepestSelectedLevel({ ROLLUP_PRODUCT: "PRODUCT_FAMILY", PRODUCT_LINE: "Martell", PRODUCT_NAME: "Martell VS" }))
      .toBe("PRODUCT_NAME");
    expect(deepestSelectedLevel({ ROLLUP_PRODUCT: "PRODUCT_FAMILY", PRODUCT_NAME: "Martell VS" })).toBeNull();
    expect(hierarchyLabel({ ROLLUP_CUSTOMER: "CUSTOMER_REGION", CUSTOMER_NAME: "France", REGION: "Europe" })).toBe("Europe / France");
    expect(hierarchyLabel({ CATEGORY_NAME: "Cognac", CUSTOMER_NAME: "China" })).toBe("Cognac / China");
    expect(hierarchyLabel({ ROLLUP_PRODUCT: "PRODUCT_TIER" })).toBe("Total portfolio");
  });
});

describe("pathToParams", () => {
  it("emits the same pairs as before for a default path", () => {
    const params = pathToParams({ CATEGORY_NAME: "Cognac", PRODUCT_NAME: null, CUSTOMER_NAME: "China", CHANNEL_NAME: "Off-trade" });
    expect(Object.entries(params)).toEqual([
      ["CATEGORY_NAME", "Cognac"],
      ["CUSTOMER_NAME", "China"],
      ["CHANNEL_NAME", "Off-trade"],
    ]);
    expect(new URLSearchParams(pathToParams({ ROLLUP_CUSTOMER: null })).toString()).toBe("");
  });
});
