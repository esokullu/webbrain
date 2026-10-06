#!/usr/bin/env node
import { BidiSession } from './session.mjs';
import { nativeReplyMessages } from './native-messages.mjs';
const session = new BidiSession();
let buffer = Buffer.alloc(0);
const pendingPageDispatchChecks = new Map();
let pageDispatchCheckSequence = 0;
function reply(value) {
  for (const message of nativeReplyMessages(value)) {
    const data = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
    process.stdout.write(Buffer.concat([header, data]));
  }
}
function validatePageDispatch(runId, guard, kind, rebindFocus = false) {
  const id = `page-dispatch-${++pageDispatchCheckSequence}`;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingPageDispatchChecks.delete(id);
      resolve(false);
    }, 5000);
    pendingPageDispatchChecks.set(id, result => {
      clearTimeout(timer);
      pendingPageDispatchChecks.delete(id);
      resolve(result === true);
    });
    reply({ id, command: 'validatePageDispatch', runId, guard, kind, rebindFocus: rebindFocus === true });
  });
}
async function dispatch(message) {
  if (typeof message?.replyTo === 'string') {
    pendingPageDispatchChecks.get(message.replyTo)?.(message.result);
    return;
  }
  const { id, command, ...args } = message;
  try {
    let result;
    switch (command) {
      case 'connect': result = await session.connect(args.port); break;
      case 'openRun': result = await session.openRun(args.runId, args.token, args.url); break;
      case 'closeRun': result = await session.closeRun(args.runId); break;
      case 'perform': result = await session.perform(args.runId, args.action, args.payload || {}, validatePageDispatch); break;
      case 'captureFullPage': result = await session.captureFullPage(args.token, args.url); break;
      default: throw new Error('Unknown companion command');
    }
    reply({ id, result });
  } catch (error) { reply({ id, error: error.message, ...(error.dispatchState ? { dispatchState: error.dispatchState } : {}) }); }
}
process.stdin.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > 40 * 1024 * 1024) process.exit(1);
    if (buffer.length < length + 4) break;
    const data = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
    try { void dispatch(JSON.parse(data)); } catch { process.exit(1); }
  }
});
process.stdin.on('end', () => {
  for (const settle of pendingPageDispatchChecks.values()) settle(false);
  void session.close().finally(() => process.exit());
});
