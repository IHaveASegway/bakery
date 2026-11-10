import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import ConfirmStep from '../src/components/ConfirmStep';
import SandboxActions from '../src/components/SandboxActions';
import { confirmation, replacedText } from '../src/lib/confirmations';

// Nothing the console deletes is asked with the browser's own dialog: Wipe now, New sandbox and
// Rotate each ask in the page (ConfirmStep), saying what will go.

const SRC = join(__dirname, '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

describe('no browser dialog', () => {
  test('no window.confirm, confirm( or alert( anywhere in the web app’s source', () => {
    for (const file of files(SRC).filter((f) => /\.(ts|tsx|astro)$/.test(f))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\b(window\.)?(confirm|alert)\(/);
    }
  });
});

describe('the questions', () => {
  test('each says what it deletes, with an action and a way back', () => {
    const wipe = confirmation('wipe', 'ABC123');
    expect(wipe.lines.join(' ')).toContain('Sandbox ABC123 is deleted for good');
    expect([wipe.confirm, wipe.cancel]).toEqual(['Wipe it', 'Keep it']);
    const replace = confirmation('replace', 'ABC123');
    expect(replace.title).toBe('Replace this sandbox?');
    expect(replace.lines.join(' ')).toContain('Sandbox ABC123 is deleted now');
    expect(replace.lines.join(' ')).toContain('seeded fresh');
    expect(confirmation('rotate').lines.join(' ')).toContain('stops working at once');
    expect(replacedText('ABC123', 'XYZ789')).toBe(
      'Sandbox XYZ789 is yours now. Sandbox ABC123 and everything in it are deleted.',
    );
  });

  test('the step is a labelled group with the action first and the way back after it', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmStep, {
        asked: confirmation('replace', 'ABC123'),
        busy: false,
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toMatch(/^<div class="confirm-step" role="group" aria-labelledby="[^"]+">/);
    expect(html.indexOf('Replace it')).toBeLessThan(html.indexOf('Keep this one'));
  });

  test('the sandbox actions ask before they act, and keep a result line the guide can find', () => {
    const html = renderToStaticMarkup(
      createElement(SandboxActions, {
        sandboxId: '01JC8YV2D4QK7S1M9E3PZ6W8AN',
        isGuest: false,
        busy: false,
        onWipe: () => undefined,
        onReplace: () => undefined,
      }),
    );
    expect(html).toContain('>Wipe now</button>');
    expect(html).toContain('>New sandbox</button>');
    expect(html).toContain('data-guide-result=""');
    expect(html).toContain('role="status"');
  });
});
