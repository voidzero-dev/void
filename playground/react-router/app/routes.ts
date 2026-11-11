import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('users', 'routes/users.tsx'),
  route('smoke', 'routes/smoke.tsx'),
  route('api/env', 'routes/api-env.ts'),
] satisfies RouteConfig;
