import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { MIN_TOKEN_LENGTH, validOperatorOwnerId } from './config.js';

type Env = Readonly<Record<string, string | undefined>>;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const HOSTNAME =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*\.?$/;

export class OperatorStartupConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`OperatorStartupConfigError:${problems.join(',')}`);
    this.name = 'OperatorStartupConfigError';
  }
}

/** Pure startup validation. It creates no storage, listeners or services and never prints values. */
export function operatorStartupConfigFromEnv(env: Env, cwd: string) {
  const problems: string[] = [];
  const localDefaults: Array<'HOST' | 'PORT' | 'DATABASE_PATH'> = [];
  const localSetting = (
    name: 'HOST' | 'PORT' | 'DATABASE_PATH',
    fallback: string,
  ) => {
    const value = env[name]?.trim() ?? '';
    if (value) return value;
    localDefaults.push(name);
    return fallback;
  };
  const host = localSetting('HOST', '127.0.0.1');
  if (host.length > 253 || (!isIP(host) && !HOSTNAME.test(host)))
    problems.push('HOST:invalid');
  const portText = localSetting('PORT', '4310');
  const port = Number(portText);
  if (
    !/^\d+$/.test(portText) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    problems.push('PORT:invalid');
  const pathText = localSetting('DATABASE_PATH', 'data/opendots.sqlite');
  if (!isAbsolute(cwd)) problems.push('working_directory:invalid');
  // A persistent incidental store cannot be SQLite's special in-memory/empty filename.
  // eslint-disable-next-line no-control-regex -- storage paths must not contain control characters
  const pathHasControls = /[\u0000-\u001f\u007f]/.test(pathText);
  if (
    pathText === ':memory:' ||
    pathText.startsWith('file:') ||
    pathHasControls ||
    pathText.endsWith('/') ||
    ['.', '..'].includes(pathText.split('/').at(-1) ?? '')
  )
    problems.push('DATABASE_PATH:invalid');
  const databasePath = resolve(cwd, pathText);
  const ownerId = env.OWNER_ID?.trim() ?? '';
  if (!ownerId) problems.push('OWNER_ID:missing');
  else if (!validOperatorOwnerId(ownerId)) problems.push('OWNER_ID:invalid');
  const ownerToken = env.OWNER_TOKEN;
  if (
    !LOOPBACK_HOSTS.has(host) &&
    (!ownerToken || ownerToken.trim().length < MIN_TOKEN_LENGTH)
  )
    problems.push('OWNER_TOKEN:required_for_external_bind');
  if (problems.length) throw new OperatorStartupConfigError(problems);
  return { host, port, databasePath, ownerId, ownerToken, localDefaults };
}
