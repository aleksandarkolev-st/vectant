const { isValidEmail } = require("./email");

test("accepts a normal email", () => {
  expect(isValidEmail("user@example.com")).toBe(true);
});

test("rejects missing @", () => {
  expect(isValidEmail("userexample.com")).toBe(false);
});

test("rejects empty local part", () => {
  expect(isValidEmail("@example.com")).toBe(false);
});

test("rejects in linear time on adversarial input", () => {
  const bad = "a".repeat(30) + "!";
  const start = Date.now();
  isValidEmail(bad);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(200);
});
