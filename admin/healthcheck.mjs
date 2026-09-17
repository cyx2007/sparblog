import { request } from 'node:http';

// The admin checks Host against its public origin, including behind Caddy.
const origin = new URL(process.env.ADMIN_ORIGIN);
const req = request(
  {
    hostname: '127.0.0.1',
    port: process.env.ADMIN_PORT || 4330,
    path: '/admin/api/session',
    headers: { Host: origin.host },
    timeout: 5000,
  },
  (res) => {
    res.resume();
    res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
  },
);
req.on('error', () => process.exit(1));
req.on('timeout', () => req.destroy());
req.end();
