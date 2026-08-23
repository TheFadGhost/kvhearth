export class BlockingRegistry {
  constructor() {
    this.waitersByKey = new Map();
    this.waiterCount = 0;
  }

  register(conn, keys, side) {
    const waiter = { conn, keys: [...keys], side, timer: null };
    for (const key of waiter.keys) {
      let queue = this.waitersByKey.get(key);
      if (queue === undefined) {
        queue = [];
        this.waitersByKey.set(key, queue);
      }
      queue.push(waiter);
    }
    this.waiterCount += 1;
    conn.blocked = waiter;
    return waiter;
  }

  attachTimer(waiter, ms, onTimeout) {
    waiter.timer = setTimeout(() => {
      if (waiter.conn.blocked === waiter) onTimeout(waiter);
    }, Math.max(ms, 0));
    if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
  }

  nextWaiterForKey(key) {
    const queue = this.waitersByKey.get(key);
    if (queue === undefined || queue.length === 0) return null;
    return queue[0];
  }

  release(waiter) {
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    for (const key of waiter.keys) {
      const queue = this.waitersByKey.get(key);
      if (queue === undefined) continue;
      const at = queue.indexOf(waiter);
      if (at !== -1) queue.splice(at, 1);
      if (queue.length === 0) this.waitersByKey.delete(key);
    }
    if (waiter.conn.blocked === waiter) waiter.conn.blocked = null;
    this.waiterCount = Math.max(this.waiterCount - 1, 0);
  }

  dropConnection(connId) {
    for (const [key, queue] of this.waitersByKey) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].conn.id === connId) {
          const waiter = queue[i];
          if (waiter.timer !== null) clearTimeout(waiter.timer);
          if (queue[i].conn.blocked === waiter) waiter.conn.blocked = null;
          queue.splice(i, 1);
          this.waiterCount = Math.max(this.waiterCount - 1, 0);
        }
      }
      if (queue.length === 0) this.waitersByKey.delete(key);
    }
  }
}
