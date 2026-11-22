import { handleRequest } from '../../src/api.js';
import snapshot from '../../generated/snapshot.js';

export function onRequest({ request }) {
  return handleRequest(request, snapshot);
}
