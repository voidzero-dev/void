import type { Node } from 'takumi-js';
import { fromHtml } from 'takumi-js/helpers/html';
import type { ImageInput } from 'void/image';

/** The backend boundary: public input shapes belong to Void, not Takumi. */
export async function toTakumiInput(
  input: ImageInput,
): Promise<{ node: Node; css: Array<string> }> {
  const element = await input;
  // Hono JSX and escaped HTML both carry this marker at runtime.
  if ((element as { isEscaped?: unknown } | null)?.isEscaped === true) {
    const result = fromHtml(String(await element.toString()));
    stripTailwindClasses(result.node);
    return result;
  }
  if (typeof element === 'string' || element instanceof String) {
    throw new TypeError('Use the html template tag from void/html instead of a plain string.');
  }
  throw new TypeError('void/image: expected Hono JSX or an escaped HTML template.');
}

function stripTailwindClasses(node: Node): void {
  // Takumi's parser promotes `tw` attributes to renderable utility classes.
  delete node.tw;
  if (node.type === 'container') {
    node.children?.forEach(stripTailwindClasses);
  }
}
