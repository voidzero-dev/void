import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { applyClientHead } from '../../src/pages/head-client.ts';

class HeadElement {
  readonly tagName: string;
  nextSibling: HeadElement | null = null;
  removed = false;
  private readonly attrs = new Map<string, string>();
  private onRemove: ((el: HeadElement) => void) | null = null;

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [key, value] of Object.entries(attrs)) {
      this.attrs.set(key, value);
    }
  }

  get attributes(): Array<{ name: string; value: string }> {
    return Array.from(this.attrs, ([name, value]) => ({ name, value }));
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  remove(): void {
    this.removed = true;
    this.onRemove?.(this);
  }

  _setRemoveCallback(callback: (el: HeadElement) => void): void {
    this.onRemove = callback;
  }
}

function stubDocumentHead(initialChildren: Array<HeadElement> = []) {
  const children = [...initialChildren];
  const syncSiblings = () => {
    for (let i = 0; i < children.length; i++) {
      children[i].nextSibling = children[i + 1] ?? null;
    }
  };
  const removeChild = (el: HeadElement) => {
    const index = children.indexOf(el);
    if (index !== -1) {
      children.splice(index, 1);
      syncSiblings();
    }
  };
  for (const child of children) {
    child._setRemoveCallback(removeChild);
  }
  syncSiblings();

  const documentStub = {
    createElement: vi.fn((tag: string) => new HeadElement(tag)),
    head: {
      appendChild: vi.fn((el: HeadElement) => {
        removeChild(el);
        el._setRemoveCallback(removeChild);
        children.push(el);
        syncSiblings();
        return el;
      }),
      insertBefore: vi.fn((el: HeadElement, before: HeadElement | null) => {
        if (el === before) {
          return el;
        }
        removeChild(el);
        el._setRemoveCallback(removeChild);
        const index = before ? children.indexOf(before) : -1;
        if (index === -1) {
          children.push(el);
        } else {
          children.splice(index, 0, el);
        }
        syncSiblings();
        return el;
      }),
      querySelector: vi.fn((selector: string) => {
        if (selector !== '[data-void-head]') {
          return null;
        }
        return children.find((el) => !el.removed && el.getAttribute('data-void-head') !== null);
      }),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector !== '[data-void-head]') {
          return [];
        }
        return children.filter((el) => !el.removed && el.getAttribute('data-void-head') !== null);
      }),
    },
    title: 'Initial',
  };

  vi.stubGlobal('document', documentStub);
  return { children, documentStub };
}

describe('head-client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves identical managed stylesheet and preload links on client head updates', () => {
    const stylesheet = new HeadElement('link', {
      'data-void-head': '',
      href: '/src/index.css',
      rel: 'stylesheet',
    });
    const font = new HeadElement('link', {
      as: 'font',
      crossorigin: 'anonymous',
      'data-void-head': '',
      href: '/fonts/SalesforceSans.woff2',
      rel: 'preload',
      type: 'font/woff2',
    });
    const staleMeta = new HeadElement('meta', {
      content: 'Old description',
      'data-void-head': '',
      name: 'description',
    });
    const { children, documentStub } = stubDocumentHead([stylesheet, font, staleMeta]);

    applyClientHead({
      title: 'Next',
      meta: [{ name: 'description', content: 'New description' }],
      link: [
        { rel: 'stylesheet', href: '/src/index.css' },
        {
          rel: 'preload',
          href: '/fonts/SalesforceSans.woff2',
          as: 'font',
          type: 'font/woff2',
          crossorigin: 'anonymous',
        },
      ],
    });

    expect(document.title).toBe('Next');
    expect(stylesheet.removed).toBe(false);
    expect(font.removed).toBe(false);
    expect(staleMeta.removed).toBe(true);
    expect(children).toContain(stylesheet);
    expect(children).toContain(font);
    expect(children).not.toContain(staleMeta);
    expect(documentStub.createElement).toHaveBeenCalledTimes(1);
    expect(documentStub.createElement).toHaveBeenCalledWith('meta');
    expect(documentStub.head.insertBefore).toHaveBeenCalledWith(
      expect.objectContaining({
        tagName: 'META',
      }),
      stylesheet,
    );
    expect(children.map((el) => el.tagName)).toEqual(['META', 'LINK', 'LINK']);
    expect(children.map((el) => el.getAttribute('href') ?? el.getAttribute('content'))).toEqual([
      'New description',
      '/src/index.css',
      '/fonts/SalesforceSans.woff2',
    ]);
  });

  it('reorders reused managed tags to match the next head descriptor', () => {
    const stylesheetA = new HeadElement('link', {
      'data-void-head': '',
      href: '/a.css',
      rel: 'stylesheet',
    });
    const stylesheetB = new HeadElement('link', {
      'data-void-head': '',
      href: '/b.css',
      rel: 'stylesheet',
    });
    const { children, documentStub } = stubDocumentHead([stylesheetB, stylesheetA]);

    applyClientHead({
      link: [
        { rel: 'stylesheet', href: '/a.css' },
        { rel: 'stylesheet', href: '/b.css' },
      ],
    });

    expect(stylesheetA.removed).toBe(false);
    expect(stylesheetB.removed).toBe(false);
    expect(documentStub.createElement).not.toHaveBeenCalled();
    expect(children).toEqual([stylesheetA, stylesheetB]);
  });

  it('inserts new managed tags in descriptor order before reused following tags', () => {
    const stylesheetB = new HeadElement('link', {
      'data-void-head': '',
      href: '/b.css',
      rel: 'stylesheet',
    });
    const { children, documentStub } = stubDocumentHead([stylesheetB]);

    applyClientHead({
      link: [
        { rel: 'stylesheet', href: '/a.css' },
        { rel: 'stylesheet', href: '/b.css' },
      ],
    });

    expect(stylesheetB.removed).toBe(false);
    expect(documentStub.createElement).toHaveBeenCalledTimes(1);
    expect(documentStub.head.insertBefore).toHaveBeenCalledWith(
      expect.objectContaining({
        tagName: 'LINK',
      }),
      stylesheetB,
    );
    expect(children.map((el) => el.getAttribute('href'))).toEqual(['/a.css', '/b.css']);
  });

  it('removes managed links that are no longer present in the next head', () => {
    const staleStylesheet = new HeadElement('link', {
      'data-void-head': '',
      href: '/old.css',
      rel: 'stylesheet',
    });
    const { children } = stubDocumentHead([staleStylesheet]);

    applyClientHead({ title: 'No links' });

    expect(staleStylesheet.removed).toBe(true);
    expect(children).toEqual([]);
  });

  it('clears document.title when the next head does not set a title', () => {
    stubDocumentHead();
    document.title = 'Previous Title';

    applyClientHead({ link: [{ rel: 'stylesheet', href: '/a.css' }] });

    expect(document.title).toBe('');
  });

  it('clears document.title when the next head is undefined', () => {
    stubDocumentHead();
    document.title = 'Previous Title';

    applyClientHead(undefined);

    expect(document.title).toBe('');
  });

  it('does not preserve tags whose attributes only match through signature delimiters', () => {
    const staleStylesheet = new HeadElement('link', {
      'data-void-head': '',
      href: '/style.css?theme=dark&media=print',
      rel: 'stylesheet',
    });
    const { children, documentStub } = stubDocumentHead([staleStylesheet]);

    applyClientHead({
      link: [
        {
          rel: 'stylesheet',
          href: '/style.css?theme=dark',
          media: 'print',
        },
      ],
    });

    expect(staleStylesheet.removed).toBe(true);
    expect(children).not.toContain(staleStylesheet);
    expect(documentStub.createElement).toHaveBeenCalledWith('link');
    expect(documentStub.head.insertBefore).toHaveBeenCalledTimes(1);
    const nextStylesheet = children[0];
    expect(nextStylesheet.getAttribute('href')).toBe('/style.css?theme=dark');
    expect(nextStylesheet.getAttribute('media')).toBe('print');
  });
});
