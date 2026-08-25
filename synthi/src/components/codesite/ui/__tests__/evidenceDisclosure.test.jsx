/* @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import JsonPreview from '../JsonPreview';
import PathList from '../PathList';
import TagList from '../TagList';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

function render(node) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

async function click(button) {
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

describe('CodeSite evidence disclosure', () => {
  it('expands compact path and tag lists instead of hiding evidence', async () => {
    render(<><PathList paths={['a.js', 'b.js', 'c.js']} maxVisible={1} /><TagList items={['one', 'two', 'three']} maxVisible={1} /></>);
    expect(container.textContent).toContain('Show 2 more');
    await click(container.querySelector('button'));
    expect(container.textContent).toContain('b.js');
    expect(container.textContent).toContain('c.js');
  });

  it('expands a truncated JSON proof preview', async () => {
    render(<JsonPreview value={'one\ntwo\nthree'} maxLines={1} />);
    expect(container.textContent).toContain('Show 2 more lines');
    await click(container.querySelector('button'));
    expect(container.querySelector('pre').textContent).toContain('three');
  });
});
