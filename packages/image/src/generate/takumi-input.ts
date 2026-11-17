import type { Node } from 'takumi-js';
import { fromHtml } from 'takumi-js/helpers/html';
import { fromJsx } from 'takumi-js/helpers/jsx';
import type { ImageInput, ImageNode } from './image-input.ts';

/** The backend boundary: public input shapes belong to Void, not Takumi. */
export async function toTakumiInput(
  input: ImageInput,
): Promise<{ node: Node; css: Array<string> }> {
  const element = await input;
  // Hono brands HTML as a string in its types, but returns a boxed string at
  // runtime. Check its marker before unboxing, including for async templates.
  if ((element as { isEscaped?: unknown } | null)?.isEscaped === true) {
    return fromHtml(element.toString());
  }
  if (typeof element === 'string' || element instanceof String) {
    throw new TypeError('Use the html template tag from void/html instead of a plain string.');
  }
  if (isImageNode(element)) {
    return { node: toTakumiNode(element), css: [] };
  }
  return fromJsx(element);
}

function isImageNode(element: unknown): element is ImageNode {
  const type = (element as { type?: unknown } | null)?.type;
  return type === 'container' || type === 'text' || type === 'image';
}

function toTakumiNode(node: ImageNode): Node {
  const { tagName, className, id, dir, lang, attributes, tw, style, preset } = node;
  const metadata = { tagName, className, id, dir, lang, attributes, tw, style, preset };
  switch (node.type) {
    case 'container':
      return { ...metadata, type: 'container', children: node.children?.map(toTakumiNode) };
    case 'text':
      return { ...metadata, type: 'text', text: node.text };
    case 'image':
      return { ...metadata, type: 'image', src: node.src, width: node.width, height: node.height };
  }
}
