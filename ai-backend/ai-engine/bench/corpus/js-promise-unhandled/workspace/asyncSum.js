async function fetchValue(x) {
  return x * 2;
}

async function sumAsync(xs) {
  let total = 0;
  for (const x of xs) {
    total += fetchValue(x); // bug: unhandled promise → string concat
  }
  return total;
}

module.exports = { sumAsync, fetchValue };
