// Catastrophic backtracking on inputs like "a".repeat(30) + "!".
const RX = /^([a-zA-Z0-9]+)+@([a-zA-Z0-9]+)+\.[a-zA-Z]+$/;

function isValidEmail(s) {
  return RX.test(s);
}

module.exports = { isValidEmail };
