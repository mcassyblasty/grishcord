export function canUserReadArchivedChannel({ archived, isAdmin }) {
  if (archived !== true) return true;
  return isAdmin === true;
}
