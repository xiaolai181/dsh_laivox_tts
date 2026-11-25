export const SHELF_SPLIT_WIDTH = 960

export function shelfMode({ split, hasBooks, hasSelectedBook, detail }) {
  if (split) return hasBooks || hasSelectedBook ? 'split' : 'books'
  return detail && hasSelectedBook ? 'detail' : 'books'
}

export function shouldLoadShelfChapters({ onShelf, mode, bookId }) {
  return Boolean(onShelf && bookId && (mode === 'split' || mode === 'detail'))
}

export function nextShelfDetailOnResize({ wasSplit, isSplit, detail, batch, renaming }) {
  if (wasSplit && !isSplit) return Boolean(batch || renaming)
  return Boolean(detail)
}
