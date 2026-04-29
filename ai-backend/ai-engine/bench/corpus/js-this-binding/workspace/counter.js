class Counter {
  constructor() {
    this.value = 0;
  }
  add(n) {
    this.value += n;
  }
  tick(steps) {
    // bug: `this` is lost when forEach calls add() without a binding
    steps.forEach(this.add);
    return this.value;
  }
}

module.exports = { Counter };
