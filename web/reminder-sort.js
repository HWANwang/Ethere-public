const DISPLAY_RANK = Object.freeze({ scheduled: 0, cancelled: 1, completed: 2 });

export function sortRemindersForDisplay(reminders = []) {
  return [...reminders].sort((left, right) => {
    const leftRank = DISPLAY_RANK[left?.status] ?? 1;
    const rightRank = DISPLAY_RANK[right?.status] ?? 1;
    return leftRank - rightRank;
  });
}
