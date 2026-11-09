import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// Worker configuration as policy (ADR 0008). Workers Cache bills each asset request at the Workers
// rate, so no Worker's config may enable it. workers_dev stays false: the zone's custom domain,
// with its WAF rule, is the only way in.

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** JSON with comments and trailing commas, as Wrangler accepts it, read as plain JSON. */
function parseJsonc(text: string): unknown {
  let json = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      json += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      json += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 1;
    } else {
      json += c;
    }
  }
  return JSON.parse(json.replace(/,(\s*[}\]])/g, '$1'));
}

const WEB = 'apps/web/wrangler.jsonc';
const API = 'workers/api/wrangler.jsonc';
// The API config is the Rust workspace's; it is checked once it exists.
const configs = [WEB, API].filter((file) => existsSync(join(root, file)));
const read = (file: string) => parseJsonc(readFileSync(join(root, file), 'utf8'));

/** Paths of every "cache" object that carries an "enabled" key, anywhere in the config. */
function cacheSettings(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path ? `${path}.${key}` : key;
    const found =
      key === 'cache' && child !== null && typeof child === 'object' && 'enabled' in child;
    return [...(found ? [here] : []), ...cacheSettings(child, here)];
  });
}

test('the storefront config exists', () => {
  expect(configs).toContain(WEB);
});

for (const file of configs) {
  describe(file, () => {
    const config = read(file) as Record<string, unknown>;

    test('never enables Workers Cache, at any level', () => {
      expect(cacheSettings(config)).toEqual([]);
    });

    test('has workers_dev false: one public origin', () => {
      expect(config['workers_dev']).toBe(false);
    });

    test('carries no account_id: it comes from the CLOUDFLARE_ACCOUNT_ID secret', () => {
      expect(JSON.stringify(config)).not.toContain('"account_id"');
    });
  });
}

describe(WEB, () => {
  const site = read(WEB) as Record<string, unknown>;

  test('is assets-only: no main, so no request runs Worker code', () => {
    expect(site['name']).toBe('bakery-web');
    expect(site).not.toHaveProperty('main');
    expect(site['assets']).toEqual({
      directory: './dist',
      not_found_handling: '404-page',
      html_handling: 'auto-trailing-slash',
    });
  });

  test('has the custom domain as its route', () => {
    expect(site['routes']).toEqual([{ pattern: 'bakery.ihaveasegway.com', custom_domain: true }]);
  });

  test('keeps Version URLs and Worker Previews, with observability on and metrics off', () => {
    expect(site['preview_urls']).toBe(true);
    expect(site['previews']).toEqual({});
    expect(site['observability']).toEqual({ enabled: true });
    expect(site['send_metrics']).toBe(false);
  });
});

// The API's CPU limit is set in PR 11 with Workers Paid; the file is the Rust workspace's, so this
// runs once it exists.
describe.skipIf(!existsSync(join(root, API)))(API, () => {
  test('sets limits.cpu_ms', () => {
    const limits = (read(API) as { limits?: { cpu_ms?: unknown } }).limits;
    expect(typeof limits?.cpu_ms).toBe('number');
  });

  test('turns invocation logs off: they record location fields', () => {
    const api = read(API) as { observability?: { logs?: { invocation_logs?: unknown } } };
    expect(api.observability?.logs?.invocation_logs).toBe(false);
  });
});
