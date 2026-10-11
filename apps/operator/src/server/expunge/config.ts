import type { ReadinessCheck } from '../../shared/expunge.js';
import { domainOrigin } from './domain-origin.js';

/** Server-side Expunge configuration, described by names and presence only. */
export interface ExpungeConfigView {
  /** `pass` means the domain origin, read projection principal and owner binding are well formed. No network. */
  configured: ReadinessCheck;
  /**
   * Which writes can work. All of them need the owner access token on the operator (an unauthenticated
   * loopback caller can read readiness only), plus the role credential for that write.
   */
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
export const OWNER_TOKEN = 'OWNER_TOKEN';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Expunge builds send no upstream telemetry unless the owner opts in with EXPUNGE_ALLOW_TELEMETRY=1,
 * whichever entry point started the server. With the opt-in, the upstream rule applies: either
 * flag set to 1 or true disables it, and so does a sample rate of 0.
 */
export function telemetryState(env: Env): 'disabled' | 'enabled' {
  if (env.EXPUNGE_ALLOW_TELEMETRY !== '1') return 'disabled';
  const off =
    ['DO_NOT_TRACK', 'COPILOTKIT_TELEMETRY_DISABLED'].some((key) =>
      ['true', '1'].includes(env[key] ?? ''),
    ) || env.COPILOTKIT_TELEMETRY_SAMPLE_RATE === '0';
  return off ? 'disabled' : 'enabled';
}

/**
 * Applies the default before the CopilotKit runtime initialises: the flag the upstream code
 * already honors is set unless the owner opted in. Called from a side-effect module that is the
 * first import of the server entry, so `npm run dev`, `npm start` and `node dist/...` all agree.
 */
export function applyTelemetryDefault(env: Record<string, string | undefined>) {
  if (env.EXPUNGE_ALLOW_TELEMETRY !== '1') env.DO_NOT_TRACK = '1';
}

/** Owner identity is supplied by configuration; no default principal is invented. */
export function validOperatorOwnerId(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- header/storage identity must not contain controls
  const hasControls = /[\u0000-\u001f\u007f]/.test(value);
  return value.trim().length > 0 && value.length <= 256 && !hasControls;
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
        ? domainOrigin(value) === null
        : name === 'OWNER_ID'
          ? !validOperatorOwnerId(value)
          : value.length < MIN_TOKEN_LENGTH
    ) {
      malformed.push(name);
      return false;
    }
    return true;
  };
  check('EXPUNGE_DOMAIN_URL', true);
  check(READ_TOKEN, true);
  check('OWNER_ID', true);
  const owner = Boolean(env[OWNER_TOKEN]?.trim());
  const submitRole = check(JOB_WRITE_TOKEN, false);
  const approveRole = check(APPROVAL_TOKEN, false);
  const submit = submitRole && owner;
  const approve = approveRole && owner;
  const writeMissing = [
    ...(owner ? [] : [OWNER_TOKEN]),
    ...(submitRole ? [] : [JOB_WRITE_TOKEN]),
    ...(approveRole ? [] : [APPROVAL_TOKEN]),
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
            'The domain service address, read projection credential and configured owner binding are present and well formed. This is not a connectivity or authentication check.',
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
