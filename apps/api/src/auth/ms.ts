const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses a short duration string like "10m" or "30d" into milliseconds. */
export default function ms(input: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(input.trim());
  if (!match) throw new Error(`Invalid duration string: "${input}"`);
  const [, amount, unit] = match;
  return Number(amount) * UNIT_MS[unit!]!;
}
