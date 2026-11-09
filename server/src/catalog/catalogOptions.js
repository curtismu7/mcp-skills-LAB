// Cache hints and page size per mode. ttlMs / cacheScope are freshness hints, not integrity properties (spec).
export const MOCK_OPTIONS = { prefix: 'demo', pageSize: 2, cacheHint: { ttlMs: 30000, cacheScope: 'public' } };
export const REAL_OPTIONS = { pageSize: 50, cacheHint: { ttlMs: 0, cacheScope: 'private' } };
