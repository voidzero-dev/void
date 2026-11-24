import type { IslandImport } from './extract-script.ts';

export type ResolvedIsland = IslandImport & Readonly<{ islandId: string }>;

// Match self-closing uppercase tags: <Counter />, <Counter attr="val" />
// and paired uppercase tags: <Counter>...</Counter>
const ISLAND_TAG_RE =
  /<([A-Z]\w*)\s*((?:[^>/"']|"[^"]*"|'[^']*')*)\/\s*>|<([A-Z]\w*)\s*((?:[^>/"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\3\s*>/g;

type IslandMatch = {
  name: string;
  start: number;
  end: number;
  attrs: string;
};

type HtmlChunk = {
  type: 'html';
  html: string;
};

type IslandChunk = {
  type: 'island';
  islandImport: ResolvedIsland;
  props: Record<string, string>;
};

export type RenderChunk = HtmlChunk | IslandChunk;

function findIslandTags(html: string, names: Set<string>): ReadonlyArray<IslandMatch> {
  const matches: Array<IslandMatch> = [];
  let match: RegExpExecArray | null;
  ISLAND_TAG_RE.lastIndex = 0;
  while ((match = ISLAND_TAG_RE.exec(html)) !== null) {
    const name = match[1] ?? match[3];
    if (names.has(name)) {
      matches.push({
        name,
        start: match.index,
        end: match.index + match[0].length,
        attrs: (match[2] ?? match[4] ?? '').trim(),
      });
    }
  }
  return matches;
}

function parseAttrs(attrStr: string) {
  const result: Record<string, string> = {};
  const attrRe = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrStr)) !== null) {
    result[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

export function buildRenderChunks(
  html: string,
  islandImports: ReadonlyArray<ResolvedIsland>,
): ReadonlyArray<RenderChunk> {
  // Pages without islands render the whole body, even when it is empty.
  if (islandImports.length === 0) {
    return [{ type: 'html', html }];
  }
  const islandByName = new Map(islandImports.map((item) => [item.name, item]));
  const tags = findIslandTags(html, new Set(islandByName.keys()));

  const chunks: Array<RenderChunk> = [];
  let cursor = 0;

  for (const tag of tags) {
    if (tag.start > cursor) {
      const segment = html.slice(cursor, tag.start);
      if (segment.trim()) {
        chunks.push({ type: 'html', html: segment });
      }
    }

    const islandImport = islandByName.get(tag.name);
    if (islandImport) {
      chunks.push({
        type: 'island',
        islandImport,
        props: parseAttrs(tag.attrs),
      });
    }

    cursor = tag.end;
  }

  if (cursor < html.length) {
    const segment = html.slice(cursor);
    if (segment.trim()) {
      chunks.push({ type: 'html', html: segment });
    }
  }

  return chunks;
}
