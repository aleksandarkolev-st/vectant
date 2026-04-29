function sortNumbers(xs) {
  // bug: default sort is lexicographic — [10, 2, 33, 4] -> [10, 2, 33, 4]
  return xs.slice().sort();
}

module.exports = { sortNumbers };
