// The shared sandbox line: the default signed-out sentence stays for the storefront pages, and a
// screen with nothing to order can say what is true for it (audit P4).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import StatusLine from '../src/components/StatusLine';

const html = (props: Parameters<typeof StatusLine>[0]) =>
  renderToStaticMarkup(createElement(StatusLine, props));

describe('StatusLine signed out', () => {
  test('defaults to the seed-menu sentence', () => {
    const out = html({ phase: { name: 'nosession' } });
    expect(out).toContain('this is the demo’s seed menu and ordering is off');
    expect(out).toContain('href="/signin/"');
  });

  test('a screen can give its own sentence, and keeps the sign-in link', () => {
    const out = html({
      phase: { name: 'nosandbox' },
      signedOut: 'You have no sandbox yet, so the inbox is empty.',
    });
    expect(out).toContain('so the inbox is empty.');
    expect(out).not.toContain('ordering is off');
    expect(out).toContain('Sign in or try it as a guest');
  });

  test('the sentence is not used for other phases', () => {
    expect(html({ phase: { name: 'loading' }, signedOut: 'x' })).not.toContain('>x');
  });
});
