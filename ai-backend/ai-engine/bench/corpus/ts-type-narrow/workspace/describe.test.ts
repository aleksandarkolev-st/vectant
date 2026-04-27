import { describe as describeValue } from "./describe";

test("string branch upper-cases", () => {
  expect(describeValue("hello")).toBe("HELLO");
});

test("number branch formats", () => {
  expect(describeValue(3.14159)).toBe("3.14");
});

test("null returns unknown", () => {
  expect(describeValue(null)).toBe("unknown");
});
