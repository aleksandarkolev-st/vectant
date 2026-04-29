function merge(a, b) {
  // bug: shallow — b.config wholly replaces a.config
  return Object.assign({}, a, b);
}

module.exports = { merge };
