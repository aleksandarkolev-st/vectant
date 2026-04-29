const { isAdmin } = require("./auth");

test("admin string matches", () => {
  expect(isAdmin("admin")).toBe(true);
});

test("non-admin role does not match", () => {
  expect(isAdmin("user")).toBe(false);
});

test("number does not match", () => {
  expect(isAdmin(0)).toBe(false);
});

test("null does not match", () => {
  expect(isAdmin(null)).toBe(false);
});
