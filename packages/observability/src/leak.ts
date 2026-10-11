import { privateIdHash } from '@expunge/contracts';

// One definition for the grader and the observer: the hash lives in contracts.
export { privateIdHash };

/**
 * Leak guard for everything that may reach a proposer, a stored evidence row or a vendor: it refuses
 *  - keys that name held-out truth (expected state, manifests, seeds, oracles, answers, ground truth, post state,
 *    preservation), matched on normalised TOKENS so renames and case variants do not slip through;
 *  - subject literals in keys AND values, compared on a folded, punctuation-free form, so a literal split by spaces,
 *    punctuation, zero-width characters or across adjacent array elements is still found;
 *  - the same literals after URL-, base64- and hex-decoding (two levels deep);
 *  - any private target id or identity token of the world, through a salted-hash set the grader exports (the raw ids
 *    never enter this process).
 * It is a refusal control, not a sanitizer: a finding means "do not store or emit this".
 */

export type PrivateIdSet = { salt: string; hashes: readonly string[] };
export type LeakGuard = { forbiddenLiterals: readonly string[]; privateIds?: PrivateIdSet };

export type LeakCode =
  'HeldOutLeak' | 'SubjectLiteral' | 'PrivateIdLeak' | 'MissingForbiddenLiterals' | 'InvalidLiteral';

export class LeakError extends Error {
  constructor(
    readonly code: LeakCode,
    readonly path?: string,
  ) {
    super(path ? `${code}:${path}` : code);
    this.name = 'LeakError';
  }
}

// Look-alikes that NFKC does not fold. This is a small, deliberate table, not a confusables database.
const LOOKALIKES: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  һ: 'h',
  ԁ: 'd',
  ӏ: 'l',
  α: 'a',
  ε: 'e',
  ο: 'o',
  ρ: 'p',
  ν: 'v',
  τ: 't',
  ι: 'i',
  κ: 'k',
  υ: 'u',
  χ: 'x',
  ɑ: 'a',
  ı: 'i',
  ℓ: 'l',
};

/** NFKC, lower case, format characters and combining marks removed, common look-alikes folded to Latin. */
export function foldText(value: string): string {
  const folded = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{M}\p{Cf}]/gu, '');
  let out = '';
  for (const char of folded) out += LOOKALIKES[char] ?? char;
  return out;
}

/** Folded text reduced to letters and digits, so separators and spacing cannot hide a literal. */
export function compact(value: string): string {
  return foldText(value).replace(/[^\p{L}\p{N}]/gu, '');
}

/** Lower-case word tokens of an identifier: camelCase, snake_case, kebab-case and dotted names. */
export function keyTokens(key: string): string[] {
  return foldText(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'))
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const STEM_PREFIXES = ['expect', 'manifest', 'seed', 'oracle', 'answer', 'preservation'] as const;
const JOINED_STEMS = [
  'heldout',
  'holdout',
  'groundtruth',
  'poststate',
  'privatetarget',
  'privateid',
] as const;

/** True when a key names held-out truth. `unexpected` and `reseed` are not matched; `expectedState` and `seeds` are. */
export function isHeldOutKey(key: string): boolean {
  const tokens = keyTokens(key);
  if (tokens.some((token) => STEM_PREFIXES.some((stem) => token.startsWith(stem)))) return true;
  const joined = tokens.join('');
  return JOINED_STEMS.some((stem) => joined.includes(stem));
}

function printable(text: string): boolean {
  if (text.length < 3) return false;
  let good = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0xfffd) return false;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) good++;
  }
  return good / [...text].length >= 0.9;
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return printable(text) ? text : null;
  } catch {
    return null;
  }
}

/** The string itself plus its URL-, base64- and hex-decoded forms (and theirs, one level further). */
export function decodedVariants(value: string, depth = 2): string[] {
  const seen = new Set<string>([value]);
  let frontier = [value];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const text of frontier) {
      const found: string[] = [];
      if (/%[0-9a-f]{2}/i.test(text)) {
        try {
          found.push(decodeURIComponent(text));
        } catch {
          /* not valid percent-encoding */
        }
      }
      for (const token of text.split(/[^A-Za-z0-9+/_=-]+/)) {
        if (token.length < 8) continue;
        if (/^(?:[0-9a-f]{2})+$/i.test(token)) {
          const decoded = decodeUtf8(Buffer.from(token, 'hex'));
          if (decoded) found.push(decoded);
        }
        if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(token)) {
          const decoded = decodeUtf8(Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
          if (decoded) found.push(decoded);
        }
      }
      for (const text2 of found) {
        if (!seen.has(text2)) {
          seen.add(text2);
          next.push(text2);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return [...seen];
}

/** A guard must name at least one literal or one private id; an empty guard would silently check nothing. */
export function requireGuard(guard: LeakGuard | undefined): asserts guard is LeakGuard {
  if (!guard || !Array.isArray(guard.forbiddenLiterals)) throw new LeakError('MissingForbiddenLiterals');
  for (const literal of guard.forbiddenLiterals)
    if (typeof literal !== 'string' || compact(literal).length === 0) throw new LeakError('InvalidLiteral');
  if (guard.forbiddenLiterals.length === 0 && !(guard.privateIds && guard.privateIds.hashes.length > 0))
    throw new LeakError('MissingForbiddenLiterals');
}

type Compiled = { literals: string[]; ids: Set<string>; salt: string };

function compile(guard: LeakGuard): Compiled {
  requireGuard(guard);
  return {
    literals: guard.forbiddenLiterals.map(compact),
    ids: new Set(guard.privateIds?.hashes ?? []),
    salt: guard.privateIds?.salt ?? '',
  };
}

function stringFinding(text: string, compiled: Compiled, path: string): LeakError | null {
  for (const variant of decodedVariants(text)) {
    const flat = compact(variant);
    if (flat && compiled.literals.some((literal) => flat.includes(literal)))
      return new LeakError('SubjectLiteral', path);
    if (compiled.ids.size) {
      const tokens = new Set([variant.trim(), ...(variant.match(/[A-Za-z0-9][A-Za-z0-9._:@-]{2,}/g) ?? [])]);
      for (const token of tokens)
        if (token && compiled.ids.has(privateIdHash(compiled.salt, token)))
          return new LeakError('PrivateIdLeak', path);
    }
  }
  return null;
}

/** The first finding in `value`, or null. Keys are checked as well as values; arrays are also checked concatenated. */
export function detectLeak(value: unknown, guard: LeakGuard): LeakError | null {
  const compiled = compile(guard);
  const walk = (node: unknown, path: string, depth: number): LeakError | null => {
    if (depth > 24) return null;
    if (typeof node === 'string') return stringFinding(node, compiled, path);
    if (Array.isArray(node)) {
      const strings = node.filter((item): item is string => typeof item === 'string');
      if (strings.length > 1) {
        const joined = stringFinding(strings.join(''), compiled, `${path}[*]`);
        if (joined) return joined;
      }
      for (const [index, item] of node.entries()) {
        const found = walk(item, `${path}[${index}]`, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (isHeldOutKey(key)) return new LeakError('HeldOutLeak', `${path}.${key}`);
        const inKey = stringFinding(key, compiled, `${path}.${key}`);
        if (inKey) return inKey;
        const found = walk(child, `${path}.${key}`, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(value, '$', 0);
}

export function assertNoLeak(value: unknown, guard: LeakGuard): void {
  const finding = detectLeak(value, guard);
  if (finding) throw finding;
}
