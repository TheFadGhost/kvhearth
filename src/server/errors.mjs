import { simple, integer, bulk, array, nilArray, error } from '../proto/serializer.mjs';

export function errProto(message) {
  return error('PROTO', message);
}

export function errSrv(message) {
  return error('SRV', message);
}

export function errOom(cmd, maxmemoryBytes) {
  return error('OOM', `${cmd}: maxmemory limit reached (${maxmemoryBytes} bytes)`);
}

export function errArity(cmd, expectation, got) {
  return error('ERR', `${cmd} wrong number of arguments (expected ${expectation}, got ${got})`);
}

export function errUnknownCommand(cmd) {
  return error('ERR', `unknown command '${cmd}'`);
}

export function errCmd(cmd, message) {
  return error('ERR', `${cmd} ${message}`);
}

export function errRange(cmd, argument, message) {
  return error('RANGE', `${cmd} ${argument}: ${message}`);
}

export function errWrongType(cmd, keyLabel, actual, expected) {
  return error('WRONGTYPE', `${cmd} key '${keyLabel}' holds ${actual}, expected ${expected}`);
}

export function ok() {
  return simple('OK');
}

export function nilBulk() {
  return bulk(null);
}

export function intReply(n) {
  return integer(n);
}

export function bulkReply(value) {
  return bulk(value);
}

export function arrayReply(items) {
  return array(items);
}

export function nilArrayReply() {
  return nilArray();
}
