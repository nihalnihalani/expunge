import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ENVIRONMENTS, SOURCE_ENVIRONMENTS } from '../src/shared/expunge.js';
import { environmentSchema } from '../src/server/expunge/schemas.js';

// Static vocabulary/DTO checks only. No record, service, provider or acceptance fixture.
it('keeps the standalone operator environments equal to the core contract', () => {
  const source = readFileSync(
    new URL('../../../packages/contracts/src/index.ts', import.meta.url),
    'utf8',
  );
  const declaration = source.match(
    /export const ENVIRONMENTS = \[([^\]]+)\]/,
  )?.[1];
  expect(declaration).toBeDefined();
  const core = [...declaration!.matchAll(/'([a-z]+)'/g)].map(
    (match) => match[1],
  );
  expect(ENVIRONMENTS).toEqual(core);
});

it('accepts explicit release environments and refuses misspellings', () => {
  for (const value of ENVIRONMENTS)
    expect(environmentSchema.parse(value)).toBe(value);
  for (const value of ['prod', 'stage', '', null, 0])
    expect(environmentSchema.safeParse(value).success).toBe(false);
});

it('keeps native-source environments limited to staging and production', () => {
  const source = readFileSync(
    new URL('../../../packages/contracts/src/source.ts', import.meta.url),
    'utf8',
  );
  const declaration = source.match(
    /sourceEnvironmentSchema = z.enum\(\[([^\]]+)\]/,
  )?.[1];
  expect(declaration).toBeDefined();
  expect(SOURCE_ENVIRONMENTS).toEqual(
    [...declaration!.matchAll(/'([a-z]+)'/g)].map((match) => match[1]),
  );
});
