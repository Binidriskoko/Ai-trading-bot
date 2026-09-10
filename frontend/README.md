# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Production deployment

This repository does not select a hosting provider. On any host with Node.js 22.5 or newer, build and run the single long-running web service from this folder:

- npm ci
- npm run build
- NODE_ENV=production npm start

Set the values in `.env.example` through the host environment or a non-committed `.env` file. Production requires `PUBLIC_URL` or `CORS_ORIGIN`, `TRADING_DB_PATH`, `ADMIN_WALLET_ADDRESS` (or `OWNER_WALLET_ADDRESS`), and `BOT_PAYMENT_RECIPIENT_ADDRESS`. `TRADING_DB_PATH` must be an absolute path on a persistent mounted directory, such as `/data/trading.sqlite`; do not use the container filesystem or `/tmp` for production data. Local development may use the default `./data/trading.sqlite` or a local `TRADING_DB_PATH`.

The server serves the built frontend and API, binds to `HOST` (default `0.0.0.0`), and uses the platform-provided `PORT` (default `8787`). Put HTTPS termination and DNS in front of it. After startup, run `npm run smoke:production` or set `SMOKE_URL` to the service origin to check `GET /api/health`.

`TRADING_MODE` defaults to `PAPER`. Live trading is fail-closed and is not enabled by this application, even if live-looking environment variables are present. Keep all credentials, session secrets, wallet values, and exchange or email credentials in the host environment; never commit them.
