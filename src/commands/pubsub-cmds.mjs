import { simple, bulk, integer, array } from '../proto/serializer.mjs';
import { errCmd } from '../server/errors.mjs';
import { define, ReplySignal } from './util.mjs';
import { latin } from './strings.mjs';

const SUBSCRIBER_ALLOWED = new Set([
  'SUBSCRIBE', 'UNSUBSCRIBE', 'PSUBSCRIBE', 'PUNSUBSCRIBE',
  'PING', 'QUIT', 'RESET',
]);

export function isSubscriberAllowed(name) {
  return SUBSCRIBER_ALLOWED.has(name);
}

function subscriptionCount(ctx, conn) {
  const state = ctx.pubsub.countsFor(conn.id);
  return state.channels.size + state.patterns.size;
}

export function registerPubsubCommands(add) {
  add(define('SUBSCRIBE', { min: 1, max: -1 }, (ctx, conn, args) => {
    const channels = args.slice(1).map(latin);
    const counts = ctx.pubsub.subscribe(conn.id, channels);
    const frames = [];
    for (let i = 0; i < channels.length; i++) {
      frames.push(array([simple('subscribe'), bulk(Buffer.from(channels[i], 'latin1')), integer(counts[i])]));
    }
    conn.subscriberMode = subscriptionCount(ctx, conn) > 0;
    return { reply: multiFrame(frames), mutations: [] };
  }));

  add(define('UNSUBSCRIBE', { min: 0, max: -1 }, (ctx, conn, args) => {
    const requested = args.length > 1 ? args.slice(1).map(latin) : null;
    const before = ctx.pubsub.countsFor(conn.id);
    const channels = requested ?? [...before.channels];
    const counts = ctx.pubsub.unsubscribe(conn.id, channels);
    const frames = [];
    for (let i = 0; i < channels.length; i++) {
      frames.push(array([simple('unsubscribe'), bulk(Buffer.from(channels[i], 'latin1')), integer(counts[i] ?? 0)]));
    }
    conn.subscriberMode = subscriptionCount(ctx, conn) > 0;
    return { reply: multiFrame(frames), mutations: [] };
  }));

  add(define('PSUBSCRIBE', { min: 1, max: -1 }, (ctx, conn, args) => {
    const patterns = args.slice(1).map(latin);
    const counts = ctx.pubsub.psubscribe(conn.id, patterns);
    const frames = [];
    for (let i = 0; i < patterns.length; i++) {
      frames.push(array([simple('psubscribe'), bulk(Buffer.from(patterns[i], 'latin1')), integer(counts[i])]));
    }
    conn.subscriberMode = subscriptionCount(ctx, conn) > 0;
    return { reply: multiFrame(frames), mutations: [] };
  }));

  add(define('PUNSUBSCRIBE', { min: 0, max: -1 }, (ctx, conn, args) => {
    const requested = args.length > 1 ? args.slice(1).map(latin) : null;
    const before = ctx.pubsub.countsFor(conn.id);
    const patterns = requested ?? [...before.patterns];
    const counts = ctx.pubsub.punsubscribe(conn.id, patterns);
    const frames = [];
    for (let i = 0; i < patterns.length; i++) {
      frames.push(array([simple('punsubscribe'), bulk(Buffer.from(patterns[i], 'latin1')), integer(counts[i] ?? 0)]));
    }
    conn.subscriberMode = subscriptionCount(ctx, conn) > 0;
    return { reply: multiFrame(frames), mutations: [] };
  }));

  add(define('PUBLISH', { min: 2, max: 2, write: false }, (ctx, conn, args) => {
    const channel = latin(args[1]);
    const payload = args[2];
    const receivers = publishMessage(ctx, channel, payload, null);
    return { reply: integer(receivers), mutations: [] };
  }));

  add(define('PUBSUB', { min: 2, max: -1 }, (ctx, conn, args) => {
    const sub = latin(args[1]).toUpperCase();
    if (sub === 'CHANNELS') {
      const pattern = args.length > 2 ? latin(args[2]) : null;
      let channels = ctx.pubsub.channelsWithSubscribers();
      if (pattern !== null) channels = channels.filter((c) => ctx.glob(pattern, c));
      return { reply: array(channels.map((c) => Buffer.from(c, 'latin1'))) };
    }
    if (sub === 'NUMSUB') {
      const channels = args.slice(2).map(latin);
      const counts = ctx.pubsub.numSub(channels);
      const flat = [];
      for (let i = 0; i < channels.length; i++) {
        flat.push(bulk(Buffer.from(channels[i], 'latin1')), integer(counts[i]));
      }
      return { reply: array(flat) };
    }
    if (sub === 'NUMPAT') {
      return { reply: integer(ctx.pubsub.patternCount()) };
    }
    throw new ReplySignal(errCmd('PUBSUB', `unsupported subcommand '${latin(args[1])}'`));
  }));
}

function multiFrame(frames) {
  if (frames.length === 1) return frames[0];
  return Buffer.concat(frames);
}

export function publishMessage(ctx, channel, payload) {
  let receivers = 0;
  const deliver = (connId, matchedChannel, deliveredPayload, matchedPatternOrNull) => {
    const target = ctx.clients.get(connId);
    if (target === undefined) return;
    const kind = matchedPatternOrNull === null ? 'message' : 'pmessage';
    const frame = array([
      simple(kind),
      bulk(Buffer.from(matchedChannel, 'latin1')),
      bulk(deliveredPayload),
    ]);
    target.outbox.push(frame);
    ctx.server.flushConn(target);
    receivers += 1;
  };
  return ctx.pubsub.publish(channel, payload, deliver);
}
