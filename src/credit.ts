/** Exact decimal Credits. Numeric JSON must be safe integers; fractions need strings. */
export function credit(input: unknown): string {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) throw new Error('Invalid Credits');
    input = String(input);
  }
  if (typeof input !== 'string' || input.length > 128 || !/^\d+(?:\.\d{1,18})?$/.test(input)) {
    throw new Error('Invalid Credits');
  }
  const [whole, fraction = ''] = input.split('.');
  const normalized = whole.replace(/^0+(?=\d)/, '');
  const tail = fraction.replace(/0+$/, '');
  return normalized + (tail ? '.' + tail : '');
}
function scaled(value: string, digits: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(digits, '0'));
}
function decimal(value: bigint, digits: number): string {
  if (!digits) return value.toString();
  const raw = value.toString().padStart(digits + 1, '0');
  return credit(raw.slice(0, -digits) + '.' + raw.slice(-digits));
}
export function balance(usedValue: unknown, limitValue: unknown) {
  const used = credit(usedValue), limit = credit(limitValue);
  const digits = Math.max(used.split('.')[1]?.length ?? 0, limit.split('.')[1]?.length ?? 0);
  const u = scaled(used, digits), l = scaled(limit, digits);
  const remaining = l > u ? l - u : 0n;
  const hundredths = l ? (remaining * 10000n + l / 2n) / l : null;
  return {
    used, limit, remaining: decimal(remaining, digits),
    remainingPercent: hundredths === null ? null :
      (hundredths / 100n).toString() + '.' + (hundredths % 100n).toString().padStart(2, '0'),
  };
}
