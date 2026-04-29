import { firstChar } from "./firstChar";

test("upper-cases first char", () => {
  expect(firstChar("hello")).toBe("H");
});

test("empty string returns empty", () => {
  expect(firstChar("")).toBe("");
});

test("undefined returns empty", () => {
  expect(firstChar(undefined)).toBe("");
});
