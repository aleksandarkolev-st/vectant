const { merge } = require("./merge");

test("flat fields are merged", () => {
  expect(merge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
});

test("nested objects are merged, not replaced", () => {
  const a = { config: { theme: "dark", layout: "compact" } };
  const b = { config: { theme: "light" } };
  expect(merge(a, b)).toEqual({
    config: { theme: "light", layout: "compact" },
  });
});

test("arrays are last-wins", () => {
  expect(merge({ xs: [1, 2] }, { xs: [3] })).toEqual({ xs: [3] });
});
