export class Evictor {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.lastRunSamples = 0;
    this.lastRunEvicted = 0;
  }

  get policy() {
    return this.config.get('maxmemory-policy');
  }

  get limit() {
    return this.config.get('maxmemory');
  }

  enforce() {
    const limit = this.limit;
    if (limit <= 0) return true;
    if (this.policy === 'noeviction') {
      return this.store.usedBytes <= limit;
    }
    let evicted = 0;
    let samples = 0;
    while (this.store.usedBytes > limit) {
      const candidates = this.store.sweepCandidates(16);
      samples += candidates.length;
      if (candidates.length === 0) break;
      let victimKey = null;
      let victimEntry = null;
      let oldest = Infinity;
      for (const [key, entry] of candidates) {
        if (entry.lastAccess < oldest) {
          oldest = entry.lastAccess;
          victimKey = key;
          victimEntry = entry;
        }
      }
      if (victimKey === null) break;
      this.store.removeEntry(victimKey, victimEntry);
      this.store.stats.evicted += 1;
      if (this.store.onEvict) this.store.onEvict(victimKey);
      evicted++;
    }
    this.lastRunSamples = samples;
    this.lastRunEvicted = evicted;
    return this.store.usedBytes <= limit;
  }
}
