export default {
  async redirects() {
    return [{ source: '/config-redirect', destination: '/', permanent: false }];
  },
  async rewrites() {
    return [{ source: '/config-rewrite', destination: '/' }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'x-void-config', value: '1' }] }];
  },
};
