export function clearUnreadThroughLatest(unreadIds, messages) {
  let changed = false;
  for (const message of messages) {
    if (message.status === 'streaming' || !unreadIds.has(message.id)) continue;
    unreadIds.delete(message.id);
    changed = true;
  }
  return changed;
}

export function unreadSince(unreadIds, previousIds) {
  return new Set([...unreadIds].filter((id) => !previousIds.has(id)));
}
