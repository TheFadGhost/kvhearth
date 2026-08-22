import { globMatch } from '../util/glob.mjs';

export class PubSubHub {
  constructor() {
    this.conns = new Map();
    this.exactIndex = new Map();
    this.patternIndex = new Map();
  }

  connRecord(connId) {
    let rec = this.conns.get(connId);
    if (!rec) {
      rec = { exact: new Set(), patterns: new Set() };
      this.conns.set(connId, rec);
    }
    return rec;
  }

  totalFor(rec) {
    return rec.exact.size + rec.patterns.size;
  }

  prune(connId) {
    const rec = this.conns.get(connId);
    if (rec && rec.exact.size === 0 && rec.patterns.size === 0) {
      this.conns.delete(connId);
    }
  }

  addExact(connId, channel) {
    const rec = this.connRecord(connId);
    rec.exact.add(channel);
    let ids = this.exactIndex.get(channel);
    if (!ids) {
      ids = new Set();
      this.exactIndex.set(channel, ids);
    }
    ids.add(connId);
  }

  removeExactIndex(connId, channel) {
    const ids = this.exactIndex.get(channel);
    if (!ids) {
      return;
    }
    ids.delete(connId);
    if (ids.size === 0) {
      this.exactIndex.delete(channel);
    }
  }

  removePatternIndex(connId, pattern) {
    const ids = this.patternIndex.get(pattern);
    if (!ids) {
      return;
    }
    ids.delete(connId);
    if (ids.size === 0) {
      this.patternIndex.delete(pattern);
    }
  }

  subscribe(connId, channels) {
    const rec = this.connRecord(connId);
    const out = [];
    for (const channel of channels) {
      this.addExact(connId, channel);
      out.push(this.totalFor(rec));
    }
    return out;
  }

  unsubscribe(connId, channels) {
    const out = [];
    const rec = this.conns.get(connId);
    if (channels === undefined || channels === null) {
      if (rec) {
        for (const channel of rec.exact) {
          this.removeExactIndex(connId, channel);
        }
        rec.exact.clear();
      }
      this.prune(connId);
      return out;
    }
    for (const channel of channels) {
      let count = 0;
      if (rec) {
        if (rec.exact.delete(channel)) {
          this.removeExactIndex(connId, channel);
        }
        count = this.totalFor(rec);
      }
      out.push(count);
    }
    this.prune(connId);
    return out;
  }

  psubscribe(connId, patterns) {
    const rec = this.connRecord(connId);
    const out = [];
    for (const pattern of patterns) {
      rec.patterns.add(pattern);
      let ids = this.patternIndex.get(pattern);
      if (!ids) {
        ids = new Set();
        this.patternIndex.set(pattern, ids);
      }
      ids.add(connId);
      out.push(this.totalFor(rec));
    }
    return out;
  }

  punsubscribe(connId, patterns) {
    const out = [];
    const rec = this.conns.get(connId);
    if (patterns === undefined || patterns === null) {
      if (rec) {
        for (const pattern of rec.patterns) {
          this.removePatternIndex(connId, pattern);
        }
        rec.patterns.clear();
      }
      this.prune(connId);
      return out;
    }
    for (const pattern of patterns) {
      let count = 0;
      if (rec) {
        if (rec.patterns.delete(pattern)) {
          this.removePatternIndex(connId, pattern);
        }
        count = this.totalFor(rec);
      }
      out.push(count);
    }
    this.prune(connId);
    return out;
  }

  publish(channel, payload, deliver) {
    const hit = new Set();
    const exactIds = this.exactIndex.get(channel);
    if (exactIds) {
      for (const connId of exactIds) {
        deliver(connId, channel, payload, null);
        hit.add(connId);
      }
    }
    for (const [pattern, ids] of this.patternIndex) {
      if (!globMatch(pattern, channel)) {
        continue;
      }
      for (const connId of ids) {
        deliver(connId, channel, payload, pattern);
        hit.add(connId);
      }
    }
    return hit.size;
  }

  drop(connId) {
    const rec = this.conns.get(connId);
    if (!rec) {
      return;
    }
    for (const channel of rec.exact) {
      this.removeExactIndex(connId, channel);
    }
    for (const pattern of rec.patterns) {
      this.removePatternIndex(connId, pattern);
    }
    this.conns.delete(connId);
  }

  channelsWithSubscribers() {
    return [...this.exactIndex.keys()].sort();
  }

  numSub(channels) {
    const out = [];
    for (const channel of channels) {
      const ids = this.exactIndex.get(channel);
      out.push(ids ? ids.size : 0);
    }
    return out;
  }

  patternCount() {
    let total = 0;
    for (const ids of this.patternIndex.values()) {
      total += ids.size;
    }
    return total;
  }
}
