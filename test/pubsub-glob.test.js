import test from 'node:test';
import assert from 'node:assert/strict';
import { globMatch } from '../src/util/glob.mjs';
import globMatchDefault from '../src/util/glob.mjs';
import { PubSubHub } from '../src/pubsub/pubsub.mjs';

test('glob: star matches any sequence including empty', () => {
  assert.equal(globMatch('*', ''), true);
  assert.equal(globMatch('*', 'anything'), true);
  assert.equal(globMatch('a*', 'a'), true);
  assert.equal(globMatch('a*', 'abc'), true);
  assert.equal(globMatch('a*b', 'ab'), true);
  assert.equal(globMatch('a*b', 'axxxxbbbb'), true);
  assert.equal(globMatch('a*b', 'b'), false);
  assert.equal(globMatch('*x', 'abcx'), true);
  assert.equal(globMatch('*x', 'abc'), false);
  assert.equal(globMatch('a*c*e', 'abcde'), true);
  assert.equal(globMatch('a*c*e', 'abcda'), false);
});

test('glob: question mark matches exactly one code unit', () => {
  assert.equal(globMatch('?', 'a'), true);
  assert.equal(globMatch('?', ''), false);
  assert.equal(globMatch('?', 'ab'), false);
  assert.equal(globMatch('a?c', 'abc'), true);
  assert.equal(globMatch('a?c', 'ac'), false);
  assert.equal(globMatch('???', 'abc'), true);
});

test('glob: exact match is case-sensitive code-unit comparison', () => {
  assert.equal(globMatch('hello', 'hello'), true);
  assert.equal(globMatch('hello', 'Hello'), false);
  assert.equal(globMatch('hello', 'hell'), false);
  assert.equal(globMatch('', ''), true);
  assert.equal(globMatch('', 'a'), false);
});

test('glob: character classes, ranges, negation', () => {
  assert.equal(globMatch('[abc]', 'a'), true);
  assert.equal(globMatch('[abc]', 'd'), false);
  assert.equal(globMatch('[a-z]', 'q'), true);
  assert.equal(globMatch('[a-z]', 'Q'), false);
  assert.equal(globMatch('[0-9]', '7'), true);
  assert.equal(globMatch('[0-9]', 'x'), false);
  assert.equal(globMatch('[a-cx]', 'x'), true);
  assert.equal(globMatch('[a-cx]', 'd'), false);
  assert.equal(globMatch('[!abc]', 'd'), true);
  assert.equal(globMatch('[!abc]', 'a'), false);
  assert.equal(globMatch('[!a-z]', '5'), true);
  assert.equal(globMatch('[!a-z]', 'm'), false);
  assert.equal(globMatch('h[aeiou]llo', 'hallo'), true);
  assert.equal(globMatch('h[aeiou]llo', 'hxllo'), false);
  assert.equal(globMatch('[]a]', ']'), true);
  assert.equal(globMatch('[]a]', 'a'), true);
  assert.equal(globMatch('[a-]', '-'), true);
});

test('glob: escapes make * ? [ literal', () => {
  assert.equal(globMatch(String.raw`a\*b`, 'a*b'), true);
  assert.equal(globMatch(String.raw`a\*b`, 'axb'), false);
  assert.equal(globMatch(String.raw`\*`, '*'), true);
  assert.equal(globMatch(String.raw`\*`, 'x'), false);
  assert.equal(globMatch(String.raw`\?`, '?'), true);
  assert.equal(globMatch(String.raw`\?`, 'a'), false);
  assert.equal(globMatch(String.raw`\[`, '['), true);
  assert.equal(globMatch(String.raw`\[`, 'a'), false);
  assert.equal(globMatch(String.raw`a\]b`, 'a]b'), true);
  assert.equal(globMatch(String.raw`\\`, '\\'), true);
  assert.equal(globMatch(String.raw`\*a\*`, '*a*'), true);
  assert.equal(globMatch(String.raw`\[*\]`, '[abc]'), true);
  assert.equal(globMatch(String.raw`\[a\]`, '[a]'), true);
});

test('glob: pathological multi-star pattern completes fast', () => {
  const pattern = '*a*a*a*a*a*a*b';
  const value = 'a'.repeat(40);
  const start = Date.now();
  const result = globMatch(pattern, value);
  const elapsed = Date.now() - start;
  assert.equal(result, false);
  assert.ok(elapsed < 1000, `took ${elapsed}ms`);
  assert.equal(globMatch(pattern, `${'a'.repeat(39)}b`), true);
});

test('glob: empty pattern vs empty string and unicode values', () => {
  assert.equal(globMatch('héllo', 'héllo'), true);
  assert.equal(globMatch('h?llo', 'héllo'), true);
  assert.equal(globMatch('naïve', 'naïve'), true);
  assert.equal(globMatch('?aïve', 'naïve'), true);
  assert.equal(globMatch('a?b', 'a😀b'), false);
  assert.equal(globMatch('a??b', 'a😀b'), true);
  assert.equal(globMatch('😀*', '😀hi'), true);
});

test('glob: named and default exports agree', () => {
  assert.equal(globMatchDefault, globMatch);
  assert.equal(globMatchDefault('a*', 'abc'), true);
});

function recorder(calls) {
  return (connId, channel, payload, pattern) => {
    calls.push({ connId, channel, payload, pattern });
  };
}

test('subscribe counts accumulate per connection independently', () => {
  const hub = new PubSubHub();
  assert.deepEqual(hub.subscribe(1, ['news']), [1]);
  assert.deepEqual(hub.subscribe(1, ['sports']), [2]);
  assert.deepEqual(hub.subscribe(2, ['news']), [1]);
  assert.deepEqual(hub.subscribe(1, ['weather']), [3]);
  assert.deepEqual(hub.numSub(['news']), [2]);
  hub.drop(1);
  assert.deepEqual(hub.numSub(['news']), [1]);
});

test('unsubscribe-all leaves zero and unknown channels yield 0', () => {
  const hub = new PubSubHub();
  hub.subscribe(1, ['a', 'b', 'c']);
  hub.psubscribe(1, ['a*']);
  assert.deepEqual(hub.unsubscribe(1), []);
  assert.equal(hub.patternCount(), 1);
  hub.punsubscribe(1);
  assert.equal(hub.patternCount(), 0);
  assert.deepEqual(hub.channelsWithSubscribers(), []);
  assert.deepEqual(hub.unsubscribe(9, ['zzz']), [0]);
  assert.deepEqual(hub.unsubscribe(9), []);
  assert.deepEqual(hub.unsubscribe(1, ['never-had']), [0]);
  hub.subscribe(1, ['keep']);
  hub.unsubscribe(1, ['keep']);
  assert.deepEqual(hub.channelsWithSubscribers(), []);
});

test('publish fans out to multiple connections with distinct counting', () => {
  const hub = new PubSubHub();
  hub.subscribe(1, ['news']);
  hub.subscribe(2, ['news']);
  hub.subscribe(3, ['news']);
  const calls = [];
  const received = hub.publish('news', 'hello', recorder(calls));
  assert.equal(received, 3);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.channel, 'news');
    assert.equal(call.payload, 'hello');
    assert.equal(call.pattern, null);
  }
  assert.deepEqual(
    calls.map((c) => c.connId).sort(),
    [1, 2, 3]
  );
});

test('exact plus matching pattern yields two deliveries but one receiver', () => {
  const hub = new PubSubHub();
  assert.deepEqual(hub.subscribe(7, ['news']), [1]);
  assert.deepEqual(hub.psubscribe(7, ['n*']), [2]);
  const payload = { body: 'untouched' };
  const calls = [];
  const received = hub.publish('news', payload, recorder(calls));
  assert.equal(received, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.pattern),
    [null, 'n*']
  );
  for (const call of calls) {
    assert.equal(call.connId, 7);
    assert.strictEqual(call.payload, payload);
  }
});

test('overlapping patterns give three deliveries for one connection', () => {
  const hub = new PubSubHub();
  hub.subscribe(5, ['news']);
  hub.psubscribe(5, ['n*']);
  hub.psubscribe(5, ['ne*']);
  const calls = [];
  const received = hub.publish('news', 'x', recorder(calls));
  assert.equal(received, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => [c.connId, c.channel, c.pattern]),
    [
      [5, 'news', null],
      [5, 'news', 'n*'],
      [5, 'news', 'ne*']
    ]
  );
});

test('pattern-only subscribers receive deliveries with matched pattern', () => {
  const hub = new PubSubHub();
  hub.psubscribe(1, ['even-*']);
  hub.psubscribe(2, ['odd-*']);
  const calls = [];
  let received = hub.publish('even-42', 'p', recorder(calls));
  assert.equal(received, 1);
  assert.deepEqual(calls, [{ connId: 1, channel: 'even-42', payload: 'p', pattern: 'even-*' }]);
  calls.length = 0;
  received = hub.publish('nothing', 'p', recorder(calls));
  assert.equal(received, 0);
  assert.equal(calls.length, 0);
});

test('unsubscribe stops deliveries; counts reflect remaining subscriptions', () => {
  const hub = new PubSubHub();
  hub.subscribe(1, ['news']);
  hub.psubscribe(1, ['n*']);
  assert.deepEqual(hub.unsubscribe(1, ['news']), [1]);
  const calls = [];
  const received = hub.publish('news', 'x', recorder(calls));
  assert.equal(received, 1);
  assert.deepEqual(
    calls.map((c) => c.pattern),
    ['n*']
  );
  assert.deepEqual(hub.punsubscribe(1, ['n*']), [0]);
  calls.length = 0;
  assert.equal(hub.publish('news', 'x', recorder(calls)), 0);
});

test('drop removes every trace and publish reaches nobody', () => {
  const hub = new PubSubHub();
  hub.subscribe(1, ['a']);
  hub.subscribe(1, ['b']);
  hub.psubscribe(1, ['a*']);
  hub.subscribe(2, ['a']);
  hub.drop(1);
  const calls = [];
  const received = hub.publish('a', 'x', recorder(calls));
  assert.equal(received, 1);
  assert.deepEqual(calls, [{ connId: 2, channel: 'a', payload: 'x', pattern: null }]);
  calls.length = 0;
  assert.equal(hub.publish('b', 'x', recorder(calls)), 0);
  assert.equal(hub.publish('zzz', 'x', recorder(calls)), 0);
  assert.equal(hub.patternCount(), 0);
  hub.drop(999);
});

test('channelsWithSubscribers is sorted and excludes emptied channels', () => {
  const hub = new PubSubHub();
  hub.subscribe(1, ['zebra', 'apple', 'mango']);
  assert.deepEqual(hub.channelsWithSubscribers(), ['apple', 'mango', 'zebra']);
  hub.subscribe(2, ['apple']);
  hub.unsubscribe(1, ['zebra', 'mango']);
  assert.deepEqual(hub.channelsWithSubscribers(), ['apple']);
  hub.unsubscribe(1, ['apple']);
  hub.unsubscribe(2, ['apple']);
  assert.deepEqual(hub.channelsWithSubscribers(), []);
});

test('numSub ignores patterns; patternCount totals across connections', () => {
  const hub = new PubSubHub();
  hub.psubscribe(1, ['n*']);
  hub.psubscribe(2, ['ne*']);
  hub.subscribe(3, ['news']);
  hub.subscribe(4, ['news']);
  hub.subscribe(4, ['noise']);
  assert.deepEqual(hub.numSub(['news']), [2]);
  assert.deepEqual(hub.numSub(['news', 'missing', 'noise']), [2, 0, 1]);
  assert.deepEqual(hub.numSub(['n*']), [0]);
  assert.equal(hub.patternCount(), 2);
});
