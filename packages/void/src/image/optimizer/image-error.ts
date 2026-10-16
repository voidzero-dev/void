/**
 * A failure the endpoint answers with `statusCode` and `message` as a plain
 * text body (Next.js `ImageError`). Statuses below 400 become 500.
 */
export class ImageError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ImageError';
    this.statusCode = statusCode >= 400 ? statusCode : 500;
  }
}

export const NOT_ALLOWED = '"url" parameter is not allowed';
export const UPSTREAM_INVALID = '"url" parameter is valid but upstream response is invalid';
export const UPSTREAM_TIMED_OUT = '"url" parameter is valid but upstream response timed out';
export const INTERNAL_INVALID = '"url" parameter is valid but internal response is invalid';
export const NOT_AN_IMAGE = "The requested resource isn't a valid image.";
export const TYPE_NOT_ALLOWED = '"url" parameter is valid but image type is not allowed';
