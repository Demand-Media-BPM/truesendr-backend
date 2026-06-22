const DEFAULT_TTLS = {
  domainExistenceMs: +(process.env.CACHE_DOMAIN_EXISTENCE_MS || 10 * 60 * 1000),
  providerMs: +(process.env.CACHE_PROVIDER_MS || 30 * 60 * 1000),
  gatewayMs: +(process.env.CACHE_GATEWAY_MS || 30 * 60 * 1000),
  reputationMs: +(process.env.CACHE_REPUTATION_MS || 5 * 60 * 1000),
  antispamDomainMs: +(process.env.CACHE_ANTISPAM_DOMAIN_MS || 60 * 60 * 1000),
};

class TTLMemoryCache {
  constructor() {
    this.map = new Map();
  }

  get(key) {
    const row = this.map.get(key);
    if (!row) return null;
    if (row.until <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return row.value;
  }

  set(key, value, ttlMs) {
    const until = Date.now() + Math.max(1, Number(ttlMs) || 1);
    this.map.set(key, { value, until });
  }
}

const cache = new TTLMemoryCache();

function namespacedKey(ns, key) {
  return `${ns}:${String(key || "").toLowerCase().trim()}`;
}

function getCached(ns, key) {
  return cache.get(namespacedKey(ns, key));
}

function setCached(ns, key, value, ttlMs) {
  cache.set(namespacedKey(ns, key), value, ttlMs);
  return value;
}

async function remember(ns, key, ttlMs, fn) {
  const hit = getCached(ns, key);
  if (hit !== null && hit !== undefined) return hit;
  const val = await fn();
  setCached(ns, key, val, ttlMs);
  return val;
}

module.exports = {
  cache,
  DEFAULT_TTLS,
  getCached,
  setCached,
  remember,
};
