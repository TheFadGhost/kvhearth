import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../src/util/clock.mjs';
import {
  Store,
  WrongTypeSignal,
  NotIntegerSignal,
  IntOverflowSignal,
  TYPE_STRING,
  TYPE_LIST,
} from '../src/store/store.mjs';

function freshStore() {
  return new Store(new Clock());
}

test('string set get round trip with ttl visibility', () => {
  const store = freshStore();
  assert.equal(store.stringSet('k', 'v1'), 'ok');
  assert.equal(store.stringGet('k'), 'v1');
  store.setExpireMs('k', store.nowMs() + 50);
  assert.equal(store.stringGet('k'), 'v1');
  store.clock.advance(60);
  assert.equal(store.stringGet('k'), null);
  assert.equal(store.typeOf('k'), 'none');
  assert.ok(store.stats.expired >= 1);
});

test('expired key is never observable even before reclaim', () => {
  const store = freshStore();
  store.stringSet('k', 'secret');
  store.setExpireMs('k', store.nowMs() + 10);
  store.clock.advance(11);
  assert.equal(store.getEntry('k'), null);
  assert.equal(store.ttlOf('k'), -2);
});

test('nx xx semantics', () => {
  const store = freshStore();
  assert.equal(store.stringSet('a', '1', { nx: true }), 'ok');
  assert.equal(store.stringSet('a', '2', { nx: true }), 'skipped');
  assert.equal(store.stringGet('a'), '1');
  assert.equal(store.stringSet('b', '1', { xx: true }), 'skipped');
  store.stringSet('b', '9');
  assert.equal(store.stringSet('b', '3', { xx: true }), 'ok');
  assert.equal(store.stringGet('b'), '3');
});

test('set keeps or drops ttl per mode', () => {
  const store = freshStore();
  store.stringSet('k', 'old');
  store.setExpireMs('k', store.nowMs() + 1000);
  store.stringSet('k', 'new');
  assert.equal(store.ttlOf('k'), -1);
  store.setExpireMs('k', store.nowMs() + 1000);
  store.stringSet('k', 'newer', { expireMode: 'keep' });
  assert.ok(store.ttlOf('k') > 0);
});

test('counter overflow and non-integer signals', () => {
  const store = freshStore();
  store.counterWrite('n', 5n);
  assert.equal(store.counterRead('n').value, 5n);
  store.stringSet('s', 'abc');
  assert.throws(() => store.counterRead('s'), NotIntegerSignal);
  assert.throws(() => store.counterWrite('big', 2n ** 63n), IntOverflowSignal);
  assert.throws(() => store.counterWrite('neg', -(2n ** 63n) - 1n), IntOverflowSignal);
});

test('list push pop both ends and count variants', () => {
  const store = freshStore();
  assert.equal(store.listPush('l', ['a', 'b'], false), 2);
  assert.equal(store.listPush('l', ['z'], true), 3);
  assert.deepEqual(store.listRange('l', 0, -1), ['z', 'a', 'b']);
  assert.equal(store.listPop('l', true, null), 'z');
  assert.equal(store.listPop('l', false, null), 'b');
  assert.deepEqual(store.listPop('l', false, -5), ['a']);
  store.listPush('l', ['x', 'y'], false);
  assert.deepEqual(store.listPop('l', false, -2), ['y', 'x']);
  assert.equal(store.listLen('l'), 0);
  assert.equal(store.typeOf('l'), 'none');
});

test('list range clamping negative indices', () => {
  const store = freshStore();
  store.listPush('l', ['1', '2', '3', '4', '5'], false);
  assert.deepEqual(store.listRange('l', -2, -1), ['4', '5']);
  assert.deepEqual(store.listRange('l', 0, 99), ['1', '2', '3', '4', '5']);
  assert.deepEqual(store.listRange('l', 99, 100), []);
  assert.deepEqual(store.listRange('missing', 0, -1), []);
});

test('wrong type signals on list ops against string key', () => {
  const store = freshStore();
  store.stringSet('k', 'v');
  assert.throws(() => store.listPush('k', ['x'], false), (err) => err instanceof WrongTypeSignal && err.actual === TYPE_STRING && err.expected === TYPE_LIST);
  assert.throws(() => store.hashGet('k', 'f'), WrongTypeSignal);
  assert.throws(() => store.setIsMember('k', 'm'), WrongTypeSignal);
  assert.throws(() => store.zsetScore('k', 'm'), WrongTypeSignal);
  assert.equal(store.listLen('other'), 0);
  void TYPE_STRING;
  void TYPE_LIST;
});

test('hash field operations', () => {
  const store = freshStore();
  assert.equal(store.hashSet('h', [['f', 'v1']]), 1);
  assert.equal(store.hashSet('h', [['f', 'v2'], ['g', 'w']]), 1);
  assert.equal(store.hashGet('h', 'f'), 'v2');
  assert.equal(store.hashGet('h', 'zz'), null);
  assert.equal(store.hashLen('h'), 2);
  assert.deepEqual(store.hashEntries('h'), [['f', 'v2'], ['g', 'w']]);
  assert.equal(store.hashDelete('h', ['f', 'nope']), 1);
  assert.equal(store.hashDelete('h', ['g']), 1);
  assert.equal(store.typeOf('h'), 'none');
});

test('hash increment by bigint with overflow guard', () => {
  const store = freshStore();
  assert.equal(store.hashIncrementBy('h', 'c', 10n), 10n);
  store.hashSet('h', [['bad', 'xyz']]);
  assert.throws(() => store.hashIncrementBy('h', 'bad', 1n), NotIntegerSignal);
  store.hashSet('h', [['max', (2n ** 63n - 1n).toString()]]);
  assert.throws(() => store.hashIncrementBy('h', 'max', 1n), IntOverflowSignal);
});

test('set membership algebra inputs', () => {
  const store = freshStore();
  store.setAdd('s1', ['a', 'b', 'c']);
  store.setAdd('s2', ['b', 'c', 'd']);
  const [one, two] = store.readSetsForAlgebra(['s1', 's2']);
  const inter = [...one].filter((x) => two.has(x));
  assert.deepEqual(inter.sort(), ['b', 'c']);
  assert.equal(store.setRemove('s1', ['a']), 1);
  assert.equal(store.setCard('s1'), 2);
  assert.equal(store.setIsMember('s1', 'a'), false);
  assert.equal(store.setAdd('empty-maker', []), 0);
  assert.equal(store.typeOf('empty-maker'), 'none');
});

test('zset ordering score then member bytes', () => {
  const store = freshStore();
  store.zsetAdd('z', [['banana', 3], ['apple', 3], ['cherry', 1]], {});
  const view = store.zsetSortedView('z');
  assert.deepEqual(view.map((p) => p[0]), ['cherry', 'apple', 'banana']);
  assert.equal(store.zsetCard('z'), 3);
  assert.equal(store.zsetScore('z', 'apple'), 3);
  assert.equal(store.zsetScore('z', 'durian'), undefined);
});

test('rename preserves value drops nothing bumps version', () => {
  const store = freshStore();
  store.stringSet('src', 'data');
  const entry = store.getEntry('src');
  const v0 = entry.version;
  assert.equal(store.renameKey('src', 'dst'), true);
  assert.equal(store.getEntry('dst').value, 'data');
  assert.ok(store.getEntry('dst').version > v0);
  assert.equal(store.typeOf('src'), 'none');
  assert.equal(store.renameKey('gone', 'anywhere'), false);
});

test('watch version detection catches mutation and delete-recreate', () => {
  const store = freshStore();
  const isDirty = (watchedKey, watchedEntry, watchedVersion) => {
    const current = store.getEntry(watchedKey);
    return current !== watchedEntry || watchedEntry.version !== watchedVersion;
  };
  store.stringSet('k', 'v0');
  let entry = store.getEntry('k');
  let v0 = entry.version;
  assert.equal(isDirty('k', entry, v0), false);
  store.stringAppend('k', '-more');
  entry = store.getEntry('k');
  assert.equal(isDirty('k', entry, v0), true);
  entry = store.getEntry('k');
  v0 = entry.version;
  store.deleteKey('k');
  store.stringSet('k', 'fresh');
  const recreated = store.getEntry('k');
  assert.equal(isDirty('k', recreated, v0), true);
});

test('active expirer step removes expired keys', () => {
  const store = freshStore();
  for (let i = 0; i < 50; i++) {
    store.stringSet(`k${i}`, String(i));
    if (i % 2 === 0) store.setExpireMs(`k${i}`, store.nowMs() + 5);
  }
  store.clock.advance(10);
  for (let i = 0; i < 10; i++) store.activeExpireStep(20);
  assert.equal(store.storedCount(), 25);
});

test('memory accounting tracks growth and release', () => {
  const store = freshStore();
  store.stringSet('a', 'hello');
  const afterOne = store.usedBytes;
  assert.ok(afterOne > 96);
  store.stringSet('b', 'x'.repeat(1000));
  const afterTwo = store.usedBytes;
  assert.ok(afterTwo > afterOne + 900);
  store.deleteKey('b');
  assert.equal(store.usedBytes, afterOne);
});
