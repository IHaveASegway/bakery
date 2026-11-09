// Which of the three shells a page takes (design brief, 2026-11-09). Prose: one column of reading,
// for the essays, About and Privacy. Shop: the storefront's width and grid, for everything a
// customer uses. App: the console's full width, top bar and sidebar.

export type Shell = 'prose' | 'shop' | 'app';

export function shellFor(path: string): Shell {
  if (path === '/app/' || path.startsWith('/app/')) return 'app';
  if (
    path.startsWith('/how-its-built/') ||
    path === '/about/' ||
    path === '/privacy/' ||
    /^\/404(\.html|\/)?$/.test(path)
  ) {
    return 'prose';
  }
  return 'shop';
}
