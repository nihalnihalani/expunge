/** Names-only guard: this process reaches database authority through scoped domain APIs. */
export function assertOperatorEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const forbidden = Object.keys(env)
    .filter((name) => name.startsWith('MONGODB_') && Boolean(env[name]?.trim()))
    .sort();
  if (forbidden.length)
    throw new Error(
      `Operator environment contains forbidden database credentials: ${forbidden.join(', ')}. Use the operator role environment.`,
    );
}
