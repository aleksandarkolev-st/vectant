const { sumAsync } = require("./asyncSum");

test("returns numeric sum", async () => {
  await expect(sumAsync([1, 2, 3])).resolves.toBe(12);
});

test("empty input is 0", async () => {
  await expect(sumAsync([])).resolves.toBe(0);
});

test("result is a number, not a string", async () => {
  const out = await sumAsync([1, 2]);
  expect(typeof out).toBe("number");
});
