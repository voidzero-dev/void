import { FetchError as OFetchError } from 'ofetch';

export type FetchResponse<T = unknown> = Response & {
  _data?: T;
};

export type FetchError<T = unknown> = Error & {
  request?: RequestInfo;
  options?: RequestInit & Record<string, unknown>;
  response?: FetchResponse<T>;
  data?: T;
  status?: number;
  statusText?: string;
  statusCode?: number;
  statusMessage?: string;
};

type FetchErrorConstructor = new <T = unknown>(
  message: string,
  opts?: { cause: unknown },
) => FetchError<T>;

export const FetchError = OFetchError as unknown as FetchErrorConstructor;
