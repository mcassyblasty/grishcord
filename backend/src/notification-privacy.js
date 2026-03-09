function asId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function isNotificationRecipientEligible(msg, authorId, userId) {
  const recipientId = asId(userId);
  const senderId = asId(authorId);
  if (!recipientId || !senderId || recipientId === senderId) return false;

  const dmPeerId = asId(msg?.dm_peer_id);
  if (!dmPeerId) return true;

  return recipientId === dmPeerId;
}

export function filterNotificationFeedRows(rows, userId) {
  const viewerId = asId(userId);
  if (!viewerId) return [];
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const dmPeerId = asId(r?.dm_peer_id);
    if (!dmPeerId) return true;
    const authorId = asId(r?.author_id);
    return authorId === viewerId || dmPeerId === viewerId;
  });
}
