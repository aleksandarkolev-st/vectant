function assignDeep(target, src) {
  for (const k of Object.keys(src)) {
    if (typeof src[k] === "object" && src[k] !== null) {
      target[k] = target[k] || {};
      assignDeep(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
  return target;
}

module.exports = { assignDeep };
