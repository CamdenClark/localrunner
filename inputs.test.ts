import { test, expect, describe } from "bun:test";
import { parseInputArgs, validateInputs, type InputDefinition } from "./inputs";

describe("parseInputArgs", () => {
  test("parses KEY=VAL pairs", () => {
    expect(parseInputArgs(["name=world", "count=3"])).toEqual({
      name: "world",
      count: "3",
    });
  });

  test("handles value containing =", () => {
    expect(parseInputArgs(["expr=a=b"])).toEqual({ expr: "a=b" });
  });

  test("handles empty value", () => {
    expect(parseInputArgs(["key="])).toEqual({ key: "" });
  });

  test("returns empty for undefined", () => {
    expect(parseInputArgs(undefined)).toEqual({});
  });

  test("throws on missing =", () => {
    expect(() => parseInputArgs(["noequals"])).toThrow("expected KEY=VALUE");
  });
});

describe("validateInputs", () => {
  test("returns defaults when no CLI values provided", () => {
    const defs: Record<string, InputDefinition> = {
      greeting: { default: "hello" },
    };
    expect(validateInputs(defs, {})).toEqual({ greeting: "hello" });
  });

  test("CLI values override defaults", () => {
    const defs: Record<string, InputDefinition> = {
      greeting: { default: "hello" },
    };
    expect(validateInputs(defs, { greeting: "world" })).toEqual({
      greeting: "world",
    });
  });

  test("empty string for optional input with no default", () => {
    const defs: Record<string, InputDefinition> = {
      name: { type: "string" },
    };
    expect(validateInputs(defs, {})).toEqual({ name: "" });
  });

  // --- required ---

  test("errors on missing required input with no default", () => {
    const defs: Record<string, InputDefinition> = {
      name: { required: true },
    };
    expect(() => validateInputs(defs, {})).toThrow("required");
  });

  test("required input with default passes when not provided", () => {
    const defs: Record<string, InputDefinition> = {
      name: { required: true, default: "fallback" },
    };
    expect(validateInputs(defs, {})).toEqual({ name: "fallback" });
  });

  test("required input satisfied by CLI value", () => {
    const defs: Record<string, InputDefinition> = {
      name: { required: true },
    };
    expect(validateInputs(defs, { name: "provided" })).toEqual({
      name: "provided",
    });
  });

  // --- boolean type ---

  test("accepts true/false for boolean type", () => {
    const defs: Record<string, InputDefinition> = {
      flag: { type: "boolean", default: "false" },
    };
    expect(validateInputs(defs, { flag: "true" })).toEqual({ flag: "true" });
    expect(validateInputs(defs, { flag: "false" })).toEqual({ flag: "false" });
  });

  test("boolean is case-insensitive", () => {
    const defs: Record<string, InputDefinition> = {
      flag: { type: "boolean" },
    };
    expect(validateInputs(defs, { flag: "True" })).toEqual({ flag: "True" });
    expect(validateInputs(defs, { flag: "FALSE" })).toEqual({ flag: "FALSE" });
  });

  test("errors on non-boolean value for boolean type", () => {
    const defs: Record<string, InputDefinition> = {
      flag: { type: "boolean" },
    };
    expect(() => validateInputs(defs, { flag: "yes" })).toThrow("must be a boolean");
  });

  // --- number type ---

  test("accepts numeric values for number type", () => {
    const defs: Record<string, InputDefinition> = {
      count: { type: "number" },
    };
    expect(validateInputs(defs, { count: "42" })).toEqual({ count: "42" });
    expect(validateInputs(defs, { count: "3.14" })).toEqual({ count: "3.14" });
    expect(validateInputs(defs, { count: "-1" })).toEqual({ count: "-1" });
  });

  test("errors on non-numeric value for number type", () => {
    const defs: Record<string, InputDefinition> = {
      count: { type: "number" },
    };
    expect(() => validateInputs(defs, { count: "abc" })).toThrow("must be a number");
  });

  test("allows empty string for optional number (no value provided)", () => {
    const defs: Record<string, InputDefinition> = {
      count: { type: "number" },
    };
    // No CLI value, no default → empty string, which we allow
    expect(validateInputs(defs, {})).toEqual({ count: "" });
  });

  // --- choice type ---

  test("accepts valid choice option", () => {
    const defs: Record<string, InputDefinition> = {
      env: { type: "choice", options: ["dev", "staging", "prod"] },
    };
    expect(validateInputs(defs, { env: "staging" })).toEqual({ env: "staging" });
  });

  test("errors on invalid choice value", () => {
    const defs: Record<string, InputDefinition> = {
      env: { type: "choice", options: ["dev", "staging", "prod"] },
    };
    expect(() => validateInputs(defs, { env: "test" })).toThrow("must be one of");
  });

  test("errors when choice has no options defined", () => {
    const defs: Record<string, InputDefinition> = {
      env: { type: "choice" },
    };
    expect(() => validateInputs(defs, { env: "anything" })).toThrow("no options defined");
  });

  test("choice default must be valid option", () => {
    const defs: Record<string, InputDefinition> = {
      env: { type: "choice", options: ["dev", "prod"], default: "dev" },
    };
    expect(validateInputs(defs, {})).toEqual({ env: "dev" });
  });

  // --- environment type ---

  test("accepts any string for environment type", () => {
    const defs: Record<string, InputDefinition> = {
      target: { type: "environment" },
    };
    expect(validateInputs(defs, { target: "production" })).toEqual({
      target: "production",
    });
  });

  // --- unknown inputs ---

  test("errors on unknown input names", () => {
    const defs: Record<string, InputDefinition> = {
      name: { type: "string" },
    };
    expect(() => validateInputs(defs, { bogus: "val" })).toThrow("Unknown input 'bogus'");
  });

  // --- no definitions ---

  test("returns empty when no definitions and no values", () => {
    expect(validateInputs(undefined, {})).toEqual({});
  });

  test("errors when values provided but no definitions", () => {
    expect(() => validateInputs(undefined, { foo: "bar" })).toThrow(
      "does not define any inputs",
    );
  });

  // --- multiple errors ---

  test("reports multiple errors at once", () => {
    const defs: Record<string, InputDefinition> = {
      name: { required: true },
      flag: { type: "boolean" },
    };
    expect(() => validateInputs(defs, { flag: "notbool" })).toThrow(/required.*\n.*boolean/s);
  });

  // --- default type is string ---

  test("defaults to string type when type not specified", () => {
    const defs: Record<string, InputDefinition> = {
      greeting: { default: "hello" },
    };
    // Should accept any string without validation error
    expect(validateInputs(defs, { greeting: "anything goes" })).toEqual({
      greeting: "anything goes",
    });
  });

  // --- boolean default coercion ---

  test("coerces boolean default to string", () => {
    const defs: Record<string, InputDefinition> = {
      flag: { type: "boolean", default: true },
    };
    expect(validateInputs(defs, {})).toEqual({ flag: "true" });
  });

  test("coerces number default to string", () => {
    const defs: Record<string, InputDefinition> = {
      count: { type: "number", default: 42 },
    };
    expect(validateInputs(defs, {})).toEqual({ count: "42" });
  });
});
