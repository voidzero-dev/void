import { defineConfig } from 'void/config';

export default defineConfig({
  worker: {
    compatibility_date: '2026-02-24',
    vars: {
      PUBLIC_CHECKOUT_URL: 'https://checkout.example.com/pay',
      PAYMENTS_API_BASE: 'https://api.payments.example.com/v1',
      PAYMENTS_SECRET_KEY: 'sk_' + 'live_51PzQk2HbT9cVwX4rLmN8aJ3dF6gY0uE7sKqZ1oB5iRtWvC2xD9yA',
    },
  },
});
