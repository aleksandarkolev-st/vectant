import { describe, expect, it } from "vitest";

import { splitArgs } from "../../src/embodied/adapters/terminal/index.js";

describe("splitArgs", () => {
  it("splits simple arguments", () => {
    expect(splitArgs("node script.js a b")).toEqual([
      "node",
      "script.js",
      "a",
      "b",
    ]);
  });

  it("keeps quoted arguments", () => {
    const args = splitArgs(
      "node -e console.log(process.argv[1]) 'hello world'",
    );

    expect(args[3]).toBe("'hello world'");
  });

  it("keeps double-quoted whitespace", () => {
    const args = splitArgs('node -e x.js "a b  c"');

    expect(args.at(-1)).toBe('"a b  c"');
  });

  it("preserves embedded quotes without splitting them", () => {
    const args = splitArgs(
      "node -e require('fs').writeFileSync('a b.txt', process.argv[1]) 'hello world'",
    );

    expect(args[0]).toBe("node");
    expect(args[1]).toBe("-e");
    expect(args[2]).toBe("require('fs').writeFileSync('a b.txt',");
    expect(args[3]).toBe("process.argv[1])");
    expect(args[4]).toBe("'hello world'");
  });

  it("does not return empty arguments", () => {
    const args = splitArgs("node    -e   x.js");

    expect(args.every((arg) => arg.length > 0)).toBe(true);
  });

  it("returns an empty array for blank input", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("   ")).toEqual([]);
  });

  it("does not throw on an unterminated quote", () => {
    expect(() => splitArgs("node -e 'unterminated")).not.toThrow();

    expect(splitArgs("node -e 'unterminated")).toHaveLength(3);
  });
});
