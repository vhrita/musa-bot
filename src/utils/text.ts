export function normalizeTitle(input: string): string {
  if (!input) return input;
  let s = input;
  // Remove common bracketed qualifiers
  const patterns = [
    /\((official\s*(video|audio)|clipe\s*oficial|audio|video|lyric(s)?|visualizer|sped\s*up|nightcore|slowed\s*(?:\+\s*reverb)?|remix)\)/ig,
    /\[(official\s*(video|audio)|clipe\s*oficial|audio|video|lyric(s)?|visualizer|sped\s*up|nightcore|slowed\s*(?:\+\s*reverb)?|remix)\]/ig,
  ];
  for (const re of patterns) s = s.replace(re, '');

  // Collapse multiple spaces and trim separators
  s = s.replace(/\s{2,}/g, ' ');
  s = s.replace(/\s*[-–—]\s*$/g, '');
  s = s.trim();
  return s;
}
