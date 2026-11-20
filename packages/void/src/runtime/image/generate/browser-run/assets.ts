/** Encode in multiples of three so chunks concatenate without padding. */
export function assetDataUrl(mediaType: string, bytes: Uint8Array): string {
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 12_288) {
    encoded += btoa(String.fromCharCode(...bytes.subarray(offset, offset + 12_288)));
  }
  return `data:${mediaType};base64,${encoded}`;
}
