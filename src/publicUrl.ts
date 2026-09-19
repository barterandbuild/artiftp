/** Local-dev fallback when neither PUBLIC_BASE_URL nor BASE_URL is set. */
export const LOCAL_DEV_BASE_URL = 'http://127.0.0.1:8787';

function envFlag(name: string): 'set' | 'missing' {
  const raw = process.env[name];
  return raw != null && raw.trim() !== '' ? 'set' : 'missing';
}

/**
 * Read a URL env var at call time. Trims whitespace, strips wrapping quotes
 * (common dashboard paste), and drops trailing slashes. Empty → undefined.
 */
function readUrlEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null) return undefined;
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\/+$/, '');
  return value || undefined;
}

function isLoopbackBase(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return /127\.0\.0\.1|localhost/i.test(url);
  }
}

/** Railway / hosted: PORT is injected, or RAILWAY_ENVIRONMENT is set. */
export function isProductionish(): boolean {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.PORT);
}

/**
 * Public origin used to mint magic/approve links. Reads env on every call so a
 * late-set Railway variable is never captured at module load.
 *
 * Precedence: PUBLIC_BASE_URL → BASE_URL → http://127.0.0.1:8787
 */
export function getPublicBaseUrl(): string {
  return readUrlEnv('PUBLIC_BASE_URL') || readUrlEnv('BASE_URL') || LOCAL_DEV_BASE_URL;
}

/** Alias kept for existing callers. */
export function getBaseUrl(): string {
  return getPublicBaseUrl();
}

/** Redact query/hash/userinfo so startup logs never print tokens. */
export function redactBaseUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '<invalid>';
  }
}

export function logPublicBaseUrlOnStartup(log: (msg: string) => void = console.log): void {
  const resolved = getPublicBaseUrl();
  log(
    `[ArtiFTP] public_base_url=${redactBaseUrlForLog(resolved)} env_PUBLIC_BASE_URL=${envFlag('PUBLIC_BASE_URL')} env_BASE_URL=${envFlag('BASE_URL')}`,
  );
  if (isProductionish() && envFlag('PUBLIC_BASE_URL') === 'missing' && isLoopbackBase(resolved)) {
    log(
      `[ArtiFTP] WARNING: PUBLIC_BASE_URL is missing in a production-like environment (PORT or RAILWAY_ENVIRONMENT is set). Magic/approve links will fall back to ${LOCAL_DEV_BASE_URL} and will not be reachable from Railway logs.`,
    );
  }
}
