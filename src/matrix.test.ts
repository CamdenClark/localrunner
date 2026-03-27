import { test, expect, describe } from "bun:test";
import { expandMatrix, filterMatrix, formatMatrixCombo } from "./matrix";

describe("expandMatrix", () => {
  test("returns empty array for undefined/null", () => {
    expect(expandMatrix(undefined)).toEqual([]);
    expect(expandMatrix(null)).toEqual([]);
  });

  test("expands single dimension", () => {
    const result = expandMatrix({ os: ["ubuntu", "macos"] });
    expect(result).toEqual([
      { os: "ubuntu" },
      { os: "macos" },
    ]);
  });

  test("expands cartesian product of multiple dimensions", () => {
    const result = expandMatrix({
      os: ["ubuntu", "macos"],
      node: [16, 18],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: "16" },
      { os: "ubuntu", node: "18" },
      { os: "macos", node: "16" },
      { os: "macos", node: "18" },
    ]);
  });

  test("applies exclude to remove matching combinations", () => {
    const result = expandMatrix({
      os: ["ubuntu", "macos"],
      node: [16, 18],
      exclude: [{ os: "macos", node: 16 }],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: "16" },
      { os: "ubuntu", node: "18" },
      { os: "macos", node: "18" },
    ]);
  });

  test("applies include to augment existing combinations", () => {
    const result = expandMatrix({
      os: ["ubuntu"],
      node: [16, 18],
      include: [{ os: "ubuntu", node: "16", experimental: "true" }],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: "16", experimental: "true" },
      { os: "ubuntu", node: "18" },
    ]);
  });

  test("applies include to add new standalone combinations", () => {
    const result = expandMatrix({
      os: ["ubuntu"],
      include: [{ os: "windows", special: "yes" }],
    });
    expect(result).toEqual([
      { os: "ubuntu" },
      { os: "windows", special: "yes" },
    ]);
  });

  test("include-only matrix (no dimensions)", () => {
    const result = expandMatrix({
      include: [
        { os: "ubuntu", version: "2204" },
        { os: "ubuntu", version: "2404" },
      ],
    });
    expect(result).toEqual([
      { os: "ubuntu", version: "2204" },
      { os: "ubuntu", version: "2404" },
    ]);
  });

  test("stringifies numeric values", () => {
    const result = expandMatrix({ shard: [0, 1, 2] });
    expect(result).toEqual([
      { shard: "0" },
      { shard: "1" },
      { shard: "2" },
    ]);
  });
});

describe("filterMatrix", () => {
  const combos = [
    { os: "ubuntu", node: "16" },
    { os: "ubuntu", node: "18" },
    { os: "macos", node: "16" },
    { os: "macos", node: "18" },
  ];

  test("returns all combinations when no filters", () => {
    expect(filterMatrix(combos, [])).toEqual(combos);
  });

  test("filters by single key:value", () => {
    expect(filterMatrix(combos, ["node:18"])).toEqual([
      { os: "ubuntu", node: "18" },
      { os: "macos", node: "18" },
    ]);
  });

  test("filters by multiple key:value pairs (AND)", () => {
    expect(filterMatrix(combos, ["node:18", "os:ubuntu"])).toEqual([
      { os: "ubuntu", node: "18" },
    ]);
  });

  test("returns empty when no matches", () => {
    expect(filterMatrix(combos, ["node:20"])).toEqual([]);
  });

  test("throws on invalid filter format", () => {
    expect(() => filterMatrix(combos, ["invalid"])).toThrow("Invalid --matrix filter");
  });
});

describe("formatMatrixCombo", () => {
  test("formats single key", () => {
    expect(formatMatrixCombo({ node: "18" })).toBe("(node: 18)");
  });

  test("formats multiple keys", () => {
    expect(formatMatrixCombo({ os: "ubuntu", node: "18" })).toBe("(os: ubuntu, node: 18)");
  });
});
