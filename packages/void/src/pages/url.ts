export function isSameOrigin(url: URL, origin: string): boolean {
  // Custom schemes have an opaque URL.origin, even for different hosts.
  if (url.protocol === 'capacitor:') {
    const current = new URL(origin);
    return current.protocol === 'capacitor:' && url.host !== '' && url.host === current.host;
  }
  return url.origin === origin;
}

function isHexDigit(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F'))
  );
}

function tryDecodeURI(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/**
 * The path a page is matched on, decoded the way the server (Hono's getPath)
 * decodes it: `/caf%C3%A9` becomes `/café`, while `%25`, reserved escapes such
 * as `%2F` and malformed escapes stay encoded.
 */
export function decodePagePath(path: string): string {
  if (!path.includes('%')) {
    return path;
  }
  const escaped = path.split('%25').join('%2525');
  try {
    return decodeURI(escaped);
  } catch {
    // Decode each run of escapes on its own, keeping the runs that fail.
  }
  let decoded = '';
  let index = 0;
  while (index < escaped.length) {
    let end = index;
    while (escaped[end] === '%' && isHexDigit(escaped[end + 1]) && isHexDigit(escaped[end + 2])) {
      end += 3;
    }
    if (end === index) {
      decoded += escaped[index++];
    } else {
      decoded += tryDecodeURI(escaped.slice(index, end));
      index = end;
    }
  }
  return decoded;
}
