const { Counter } = require("./counter");

test("tick sums steps", () => {
  const c = new Counter();
  expect(c.tick([1, 2, 3])).toBe(6);
});

test("tick from a non-zero start", () => {
  const c = new Counter();
  c.add(5);
  expect(c.tick([10, 20])).toBe(35);
});
