const { sortNumbers } = require("./sort");

test("sorts ascending numerically", () => {
  expect(sortNumbers([10, 2, 33, 4])).toEqual([2, 4, 10, 33]);
});

test("does not mutate input", () => {
  const xs = [3, 1, 2];
  sortNumbers(xs);
  expect(xs).toEqual([3, 1, 2]);
});

test("empty input", () => {
  expect(sortNumbers([])).toEqual([]);
});
