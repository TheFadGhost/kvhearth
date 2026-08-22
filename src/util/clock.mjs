export class Clock {
  constructor() {
    this.offsetMs = 0;
    this.frozenAt = null;
  }

  nowMs() {
    if (this.frozenAt !== null) return this.frozenAt + this.offsetMs;
    return Date.now() + this.offsetMs;
  }

  advance(ms) {
    this.offsetMs += ms;
  }

  freeze() {
    this.frozenAt = Date.now();
    return this.frozenAt;
  }

  unfreeze() {
    this.frozenAt = null;
    this.offsetMs = 0;
  }
}
