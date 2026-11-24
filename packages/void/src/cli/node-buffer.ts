import { Buffer as NodeBuffer } from 'node:buffer';

// Workers types 5 declares Buffer as any, including node:buffer's exported value
// in a mixed Node/Workers project. Keep Node's constructor signatures in the CLI.
export const Buffer = NodeBuffer as BufferConstructor;
export type Buffer<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> =
  NodeBuffer<TArrayBuffer>;
