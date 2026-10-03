/** Validate display names before login and before storing account changes. */
export function felixAccountLabel(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('Enter an account name.');
  const label = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!label || label.length > 40) {
    throw new Error('Account names must be 1–40 characters.');
  }
  return label;
}
