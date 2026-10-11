/** Pure display helpers. */
export function shortHash(value: string, head = 8, tail = 6) {
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatTime(iso: string | null | undefined) {
  if (!iso) return 'not yet';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'unknown';
  return new Date(time).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatClock(ms: number | null) {
  if (ms === null) return 'never';
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function ageText(ms: number, now: number) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** USD with an explicit unpriced note; micro-dollars are integers (CONTRACTS). */
export function formatMicrousd(microusd: number) {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}
