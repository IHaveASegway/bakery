// The three shells (design brief, 2026-11-09) and the console's sidebar: which page takes which
// shell, and the sidebar's seven workspaces over the console's sections.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import ConsoleNav from '../src/components/ConsoleNav';
import { CONSOLE_SECTIONS, WORKSPACES, sectionsOf } from '../src/lib/console-sections';
import { shellFor } from '../src/lib/shell';

describe('shellFor', () => {
  test('the console and its pages take the app shell', () => {
    expect(shellFor('/app/')).toBe('app');
    expect(shellFor('/app/dispatch/')).toBe('app');
  });

  test('reading takes the prose shell', () => {
    for (const path of [
      '/how-its-built/',
      '/how-its-built/outbox/',
      '/about/',
      '/privacy/',
      '/404',
      '/404.html',
    ]) {
      expect(shellFor(path), path).toBe('prose');
    }
  });

  test('everything a customer uses takes the shop shell', () => {
    for (const path of [
      '/',
      '/menu/',
      '/checkout/',
      '/catering/',
      '/inbox/',
      '/status/',
      '/signin/',
      '/docs/api/',
    ]) {
      expect(shellFor(path), path).toBe('shop');
    }
  });
});

describe('the console’s workspaces', () => {
  test('seven, in the brief’s order, and every section belongs to one of them', () => {
    expect(WORKSPACES.map((w) => w.label)).toEqual([
      'Kitchen',
      'Money',
      'Menu',
      'Catering',
      'Customers',
      'Dispatch',
      'System',
    ]);
    const ids = new Set(WORKSPACES.map((w) => w.id));
    for (const s of CONSOLE_SECTIONS) expect(ids.has(s.workspace), s.id).toBe(true);
  });

  test('the sections run workspace by workspace, so the page reads in the sidebar’s order', () => {
    const order = WORKSPACES.flatMap((w) => sectionsOf(w.id).map((s) => s.id));
    expect(order).toEqual(CONSOLE_SECTIONS.map((s) => s.id));
  });

  test('on the dispatch page the sidebar marks Dispatch current and leads to every workspace', () => {
    const html = renderToStaticMarkup(createElement(ConsoleNav, { here: 'dispatch' }));
    expect(html).toContain('aria-label="Console"');
    expect(html).toContain('href="/app/"');
    expect(html).toMatch(/<a href="\/app\/dispatch\/" aria-current="page">/);
    expect(html).not.toMatch(/href="#/);
  });
});
