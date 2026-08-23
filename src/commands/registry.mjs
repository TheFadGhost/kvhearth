import { registerStringCommands } from './strings.mjs';
import { registerListCommands } from './lists.mjs';
import { registerBlockingListCommands, wakeListWaiters } from './blocking-lists.mjs';
import { registerHashCommands } from './hashes.mjs';
import { registerSetCommands } from './sets.mjs';
import { registerZsetCommands } from './zsets.mjs';
import { registerKeyCommands } from './keys.mjs';
import { registerServerCommands } from './server-cmds.mjs';
import { registerTransactionCommands, isTxnControl } from './txns.mjs';
import { registerPubsubCommands, publishMessage, isSubscriberAllowed } from './pubsub-cmds.mjs';

export function buildRegistry(ctx) {
  const map = new Map();
  const add = (definition) => {
    if (map.has(definition.name)) {
      throw new Error(`duplicate command registration: ${definition.name}`);
    }
    definition.meta.name = definition.name;
    map.set(definition.name, definition);
  };
  registerStringCommands(add);
  registerListCommands(add);
  registerBlockingListCommands(add);
  registerHashCommands(add);
  registerSetCommands(add);
  registerZsetCommands(add);
  registerKeyCommands(add);
  registerServerCommands(add);
  registerTransactionCommands(add);
  registerPubsubCommands(add);
  ctx.registry = map;
}

export { isTxnControl, isSubscriberAllowed, wakeListWaiters, publishMessage };
