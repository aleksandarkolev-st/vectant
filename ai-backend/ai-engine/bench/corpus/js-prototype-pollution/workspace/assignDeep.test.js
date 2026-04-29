const { assignDeep } = require("./assignDeep");

test("normal nested merge works", () => {
  const t = { a: { x: 1 } };
  assignDeep(t, { a: { y: 2 }, b: 3 });
  expect(t).toEqual({ a: { x: 1, y: 2 }, b: 3 });
});

test("rejects __proto__ keys", () => {
  const malicious = JSON.parse('{"__proto__":{"polluted":"yes"}}');
  assignDeep({}, malicious);
  expect({}.polluted).toBeUndefined();
});

test("rejects constructor.prototype injection", () => {
  const malicious = JSON.parse(
    '{"constructor":{"prototype":{"polluted":"yes"}}}'
  );
  assignDeep({}, malicious);
  expect({}.polluted).toBeUndefined();
});
