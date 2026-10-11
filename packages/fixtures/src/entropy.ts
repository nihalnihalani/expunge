/**
 * Entropy screen for secrets that every held-out ID derives from. A format check alone accepts "00..0", so this
 * also requires a spread of distinct characters and a Shannon entropy close to that of random hex (about 3.8
 * bits per character). It rejects guessable and degenerate values; it cannot prove a value was random.
 */
export function isHighEntropySeed(value: unknown, minimumHexLength = 32): boolean {
  if (typeof value !== 'string' || value.length < minimumHexLength || !/^[0-9a-f]+$/.test(value))
    return false;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  if (counts.size < 10) return false;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.2;
}
