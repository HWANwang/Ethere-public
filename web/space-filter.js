function isoDayNumber(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

export function matchesSpacePost(post, filters, todayIso) {
  const authorMatches = filters.author === 'all' || post.author === filters.author;
  if (!authorMatches) return false;

  if (filters.time === 'all') return true;
  if (filters.time === 'custom') {
    return Boolean(filters.start && filters.end && post.date >= filters.start && post.date <= filters.end);
  }

  const days = Number(filters.time);
  if (!Number.isFinite(days) || days <= 0) return false;
  const age = isoDayNumber(todayIso) - isoDayNumber(post.date);
  return age >= 0 && age < days;
}
