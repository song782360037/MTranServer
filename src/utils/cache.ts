import crypto from 'crypto';
import { LRUCache } from 'lru-cache';
import { getConfig } from '@/config/index.js';

const config = getConfig();

// Initialize cache with a safe fallback size if disabled.
// Actual enabling/disabling is handled in the read/write functions.
const cache = new LRUCache<string, string>({
  max: config.cacheSize > 0 ? config.cacheSize : 1,
});

// Threshold for using simple concatenation vs SHA1 hash
const SIMPLE_KEY_THRESHOLD = 200;

/**
 * Generates a collision-resistant cache key from arguments.
 * Uses simple concatenation for short keys, SHA1 for longer ones.
 */
function getCacheKey(args: any[]): string {
  // For short inputs, direct concatenation is faster than hashing
  const simpleKey = args.map(arg => String(arg)).join('\0');
  
  if (simpleKey.length <= SIMPLE_KEY_THRESHOLD) {
    return simpleKey;
  }
  
  // For longer inputs, use SHA1 to keep key size manageable
  const hash = crypto.createHash('sha1');
  hash.update(simpleKey);
  return hash.digest('hex');
}

export function readCache(args: any[]): string | null {
  if (config.cacheSize <= 0) {
    return null;
  }

  const key = getCacheKey(args);
  return cache.get(key) || null;
}

export function writeCache(result: string, args: any[]): void {
  if (config.cacheSize <= 0) {
    return;
  }

  const key = getCacheKey(args);
  cache.set(key, result);
}