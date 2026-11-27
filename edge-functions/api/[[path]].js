import { handleRequest } from '../../src/api.js';
import snapshot from '../../generated/snapshot.js';

export function onRequest(context) {
  return handleRequest(context.request, snapshot, { waitUntil: task => context.waitUntil(task) });
}
