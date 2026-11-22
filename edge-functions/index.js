import { handleRequest } from '../src/api.js';
import snapshot from '../generated/snapshot.js';

export default function onRequest({ request }) {
  const url = new URL(request.url);
  url.pathname = '/api/health';
  return handleRequest(new Request(url, request), snapshot);
}
