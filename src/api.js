const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja'];
const READ_CACHE = 'public, max-age=60, s-maxage=300';

function json(request, value, status = 200, extraHeaders = {}) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? READ_CACHE : 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function error(request, status, code, message, headers = {}) {
  return json(request, { error: code, message }, status, headers);
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!value || !/^\d+$/.test(value)) return fallback;
  return Math.min(maximum, Math.max(1, Number(value)));
}

function fold(value) {
  return String(value ?? '').toLowerCase();
}

function selectCatalog(snapshot, requestedLanguage) {
  const language = LANGUAGES.find((item) => fold(item) === fold(requestedLanguage)) ?? 'zh-Hans';
  const available = snapshot?.languages ?? {};
  const fallback = available['zh-Hans'] ?? Object.values(available)[0];
  const catalog = available[language] ?? fallback;
  return { language, catalog };
}

function findDetail(catalog, requestedId) {
  const details = catalog.details ?? {};
  const key = Object.keys(details).find((id) => fold(id) === fold(requestedId));
  return key === undefined ? undefined : details[key];
}

function listMods(request, url, snapshot, catalog, language) {
  const parameters = url.searchParams;
  const query = fold(parameters.get('query')?.trim());
  const tag = fold(parameters.get('tag')?.trim());
  const sort = parameters.get('sort');
  const page = positiveInteger(parameters.get('page'), 1);
  const pageSize = positiveInteger(parameters.get('pageSize'), 24, 60);
  const allItems = catalog.items;
  const tags = [...new Set(allItems.flatMap((item) => item.tags ?? []))]
    .sort((a, b) => a.localeCompare(b, language));
  const items = allItems.filter((item) => {
    if (tag && !(item.tags ?? []).some((value) => fold(value) === tag)) return false;
    if (!query) return true;
    return [item.id, item.name, item.summary, item.author, ...(item.tags ?? [])]
      .some((value) => fold(value).includes(query));
  });
  const stableOrder = (left, right) => String(left.id).localeCompare(String(right.id), 'en');
  items.sort((left, right) => {
    if (sort === 'name') {
      return String(left.name ?? '').localeCompare(String(right.name ?? ''), language)
        || stableOrder(left, right);
    }
    if (sort === 'downloads') {
      return (Number(right.downloads) || 0) - (Number(left.downloads) || 0)
        || stableOrder(left, right);
    }
    return (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)
      || stableOrder(left, right);
  });
  const offset = (page - 1) * pageSize;
  return json(request, {
    apiVersion: 1,
    generatedAt: snapshot.generatedAt,
    total: items.length,
    page,
    pageSize,
    tags,
    items: items.slice(offset, offset + pageSize),
  });
}

function redirectToAsset(request, value, prefix) {
  // A snapshot is supposed to contain only mirrored static paths. Never turn
  // malformed upstream metadata into an open redirect or a live origin fetch.
  if (typeof value !== 'string' || !value.startsWith(prefix)
      || value.includes('\\') || /[\r\n]/.test(value)) {
    return error(request, 503, 'asset_unavailable', 'This asset is not present in the mirror snapshot.');
  }
  const parsed = new URL(value, 'https://mirror.invalid');
  if (!parsed.pathname.startsWith(prefix) || parsed.origin !== 'https://mirror.invalid') {
    return error(request, 503, 'asset_unavailable', 'This asset is not present in the mirror snapshot.');
  }
  return new Response(null, {
    status: 302,
    headers: { location: value, 'cache-control': READ_CACHE, 'x-content-type-options': 'nosniff' },
  });
}

function stickerCounts(request, url, snapshot) {
  const requestedIds = [...new Map((url.searchParams.get('modIds') ?? '').split(',')
    .map((id) => id.trim()).filter(Boolean).map((id) => [fold(id), id])).values()].slice(0, 100);
  const states = new Map((snapshot.modStickers?.items ?? []).map((item) => [fold(item.modId), item]));
  const items = requestedIds.map((modId) => {
    const state = states.get(fold(modId));
    if (!state) return { modId, stickers: [], reactionTotal: 0 };
    return {
      ...state,
      stickers: (state.stickers ?? []).map((sticker) => ({ ...sticker, reactedByMe: false })),
    };
  });
  return json(request, {
    generatedAt: snapshot.modStickers?.generatedAt ?? snapshot.generatedAt,
    items,
  }, 200, { 'cache-control': 'no-store' });
}

/** Serve the Forge public protocol entirely from one immutable sync snapshot. */
export function handleRequest(request, snapshot) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (!pathname.startsWith('/api/')) {
    return error(request, 404, 'not_found', 'This mirror provides the Toys market API only.');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return error(request, 405, 'read_only', 'This is a read-only market mirror; reactions are not accepted.', {
      allow: /\/reactions$/.test(pathname) ? '' : 'GET, HEAD',
    });
  }

  const { language, catalog } = selectCatalog(snapshot, url.searchParams.get('lang'));
  const ready = snapshot?.schemaVersion === 1 && Array.isArray(catalog?.items)
    && catalog?.details && typeof catalog.details === 'object' && Boolean(snapshot.generatedAt);
  if (pathname === '/api/health') {
    return json(request, {
      status: ready ? 'ok' : 'unavailable',
      readOnly: true,
      schemaVersion: snapshot?.schemaVersion ?? null,
      generatedAt: snapshot?.generatedAt ?? null,
      upstream: snapshot?.upstream ?? null,
      languages: Object.keys(snapshot?.languages ?? {}),
      mods: catalog?.items?.length ?? 0,
      versions: ready ? Object.values(catalog.details)
        .reduce((total, detail) => total + (detail.versions?.length ?? 0), 0) : 0,
    }, ready ? 200 : 503, { 'cache-control': 'no-store' });
  }

  if (!ready) return error(request, 503, 'snapshot_unavailable', 'Run a successful sync before deploying this mirror.');
  if (pathname === '/api/mods') return listMods(request, url, snapshot, catalog, language);
  if (pathname === '/api/stickers') {
    return json(request, snapshot.stickerCatalog ?? {
      generatedAt: snapshot.generatedAt, groups: [], items: [], total: 0,
    });
  }
  if (pathname === '/api/mod-stickers') return stickerCounts(request, url, snapshot);

  const match = /^\/api\/mods\/([^/]+)(?:\/(download|cover))?$/.exec(pathname);
  if (!match) return error(request, 404, 'not_found', 'Unknown market API route.');
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return error(request, 400, 'invalid_id', 'The mod ID is not valid URL encoding.');
  }
  const detail = findDetail(catalog, id);
  if (!detail) return error(request, 404, 'mod_not_found', 'This mod is not present in the mirror snapshot.');
  if (!match[2]) return json(request, detail);
  if (match[2] === 'cover') {
    if (!detail.coverUrl) return error(request, 404, 'cover_not_found', 'This mod has no mirrored cover.');
    return redirectToAsset(request, detail.coverUrl, '/covers/');
  }
  const version = url.searchParams.get('version')?.trim() || detail.latestVersion;
  const selected = (detail.versions ?? []).find((item) => fold(item.version) === fold(version));
  if (!selected) return error(request, 404, 'version_not_found', 'This version is not present in the mirror snapshot.');
  return redirectToAsset(request, selected.downloadUrl, '/packages/');
}
