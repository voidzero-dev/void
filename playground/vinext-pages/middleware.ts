import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/middleware-redirect') {
    return NextResponse.redirect(new URL('/', request.url));
  }
  const response =
    request.nextUrl.pathname === '/middleware-rewrite'
      ? NextResponse.rewrite(new URL('/', request.url))
      : NextResponse.next();
  response.headers.set('x-void-middleware', '1');
  return response;
}

export const config = { matcher: ['/((?!_next).*)'] };
