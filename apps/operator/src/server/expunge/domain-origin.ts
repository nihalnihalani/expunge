const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** One credential-bearing origin policy for configuration and transport construction. */
export function domainOrigin(value: string): string | null {
  const input = value.trim();
  try {
    const url = new URL(input);
    const protocolAllowed =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    // Exact origin spelling also rejects empty userinfo/delimiters, backslashes and paths
    // that URL normalization would silently turn into '/'. A single trailing '/' is harmless.
    return protocolAllowed &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      (input === url.origin || input === `${url.origin}/`)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Fetch must refuse every redirect before a service bearer can be forwarded. */
export const DOMAIN_REDIRECT_POLICY = 'error' as const;
