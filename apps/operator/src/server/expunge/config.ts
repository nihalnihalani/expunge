import type { ReadinessCheck } from '../../shared/expunge.js';

/** Server-side Expunge configuration, described by names and presence only. */
export interface ExpungeConfigView {
  /** `pass` means the read projection principal is present and well formed. No network. */
  configured: ReadinessCheck;
  writes: {
    submit: boolean;
    cancel: boolean;
    approve: boolean;
    missing: string[];
  };
  telemetry: 'disabled' | 'enabled';
}

export const MIN_TOKEN_LENGTH = 24;
export const READ_TOKEN = 'EXPUNGE_INTERNAL_TOKEN';
export const JOB_WRITE_TOKEN = 'EXPUNGE_JOB_WRITE_TOKEN';
export const APPROVAL_TOKEN = 'EXPUNGE_APPROVAL_TOKEN';

type Env = Readonly<Record<string, string | undefined>>;

/** Mirrors the upstream rule in setup-telemetry.ts: either flag set to 1 or true disables it. */
export function telemetryState(env: Env): 'disabled' | 'enabled' {
  const off =
    ['DO_NOT_TRACK', 'COPILOTKIT_TELEMETRY_DISABLED'].some((key) =>
      ['true', '1'].includes(env[key] ?? ''),
    ) || env.COPILOTKIT_TELEMETRY_SAMPLE_RATE === '0';
  return off ? 'disabled' : 'enabled';
}

function validOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function describeExpungeConfig(env: Env): ExpungeConfigView {
  const missing: string[] = [];
  const malformed: string[] = [];
  const check = (name: string, required: boolean) => {
    const value = env[name]?.trim() ?? '';
    if (!value) {
      if (required) missing.push(name);
      return false;
    }
    if (
      name === 'EXPUNGE_DOMAIN_URL'
        ? !validOrigin(value)
        : value.length < MIN_TOKEN_LENGTH
    ) {
      malformed.push(name);
      return false;
    }
    return true;
  };
  check('EXPUNGE_DOMAIN_URL', true);
  check(READ_TOKEN, true);
  const submit = check(JOB_WRITE_TOKEN, false);
  const approve = check(APPROVAL_TOKEN, false);
  const writeMissing = [
    ...(submit ? [] : [JOB_WRITE_TOKEN]),
    ...(approve ? [] : [APPROVAL_TOKEN]),
  ];
  const names = [...missing, ...malformed];
  const readFailure = names.filter(
    (name) => name !== JOB_WRITE_TOKEN && name !== APPROVAL_TOKEN,
  );
  const configured: ReadinessCheck =
    readFailure.length === 0
      ? {
          status: 'pass',
          reason: null,
          missing: [],
          detail:
            'The domain service address and the read projection credential are present and well formed. This is not a connectivity check.',
          observedAt: new Date().toISOString(),
        }
      : {
          status: 'fail',
          reason: missing.length ? 'env_missing' : 'env_malformed',
          missing: readFailure,
          detail: missing.length
            ? 'Server configuration is missing. Set the named variables in the server environment and restart the operator.'
            : 'Server configuration is present but malformed. Check the named variables.',
          observedAt: new Date().toISOString(),
        };
  return {
    configured,
    writes: {
      submit,
      cancel: submit,
      approve,
      missing: writeMissing,
    },
    telemetry: telemetryState(env),
  };
}
