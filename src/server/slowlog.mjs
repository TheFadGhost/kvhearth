export class SlowLog {
  constructor(maxLen) {
    this.maxLen = maxLen;
    this.entries = [];
    this.seqCounter = 0;
  }

  record(durationMicros, argv, address) {
    if (this.maxLen <= 0) return;
    const truncatedArgv = argv.slice(0, 32).map((arg) => {
      if (arg.length > 128) return Buffer.concat([arg.subarray(0, 125), Buffer.from('...', 'latin1')]);
      return arg;
    });
    this.entries.push({
      seq: ++this.seqCounter,
      timestampSeconds: Math.floor(Date.now() / 1000),
      durationMicros,
      argv: truncatedArgv,
      address,
    });
    while (this.entries.length > this.maxLen) this.entries.shift();
  }

  get(count) {
    if (count === undefined || !Number.isFinite(count)) return [...this.entries].reverse();
    const n = Math.max(Math.min(count, this.entries.length), 0);
    return this.entries.slice(this.entries.length - n).reverse();
  }

  len() {
    return this.entries.length;
  }

  reset() {
    this.entries = [];
  }
}
