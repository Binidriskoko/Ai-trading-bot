# Scalability, trading intelligence, and operational audit

## 1. Current architecture

The application currently uses a lightweight local full-stack pattern:

- Frontend: React single-page app in `frontend/src` served by Vite.
- Backend: a Node HTTP server in `frontend/server/index.mjs` with SQLite persistence through `frontend/server/db.mjs`.
- Session model: signed-in users receive a server-generated session token, stored as a SHA-256 hash in SQLite with one-week expiry.
- Auth: password hashing uses scrypt with a fixed salt; owner/admin authorization is enforced on the server side.
- Financial ledger: all user and admin financial events are stored as immutable ledger records for auditability.
- Trading logic: demo trading engine runs in the browser and uses a simple signal model and risk controls, while server-side protections remain the source of truth for wallet, withdrawals, and ownership checks.

## 2. Current database architecture

SQLite is the primary database, configured with:

- WAL mode for concurrent reads and writes.
- foreign_keys enabled.
- busy_timeout configured to reduce transient contention on short transactions.
- important indexes on frequent lookup paths such as payment review, session expiry, ledger lookups, and reset-token expiry.

The main tables are:

- `users`
- `sessions`
- `referrals`
- `ledger`
- `audit_logs`
- `bot_payments`
- `settings`
- `password_reset_tokens`

Key integrity constraints include non-negative balance checks, ledger amount checks, and unique reference constraints for withdrawals, bot payment references, and other financial identifiers.

## 3. Known bottlenecks and scaling limits

This project is intentionally small and local-first. The main bottlenecks are:

- SQLite is single-writer under heavy contention; it scales well for moderate load but not the same way as a multi-node DB.
- The admin bootstrap endpoint returns a broad set of data and is suitable for small to medium deployments only.
- Browser-side simulation can accumulate state and history in memory if a dashboard pulls too much data.
- Large ledger tables can become expensive if unbounded queries are requested without pagination or index support.
- A single server process is acceptable for local development, but a production deployment eventually needs process separation for API and worker tasks.

## 4. What scales vertically

The following can be scaled upward without redesigning the application:

- increasing CPU and RAM for a single Node process,
- moving the SQLite file to faster local SSD storage,
- reducing query fan-out with indexes and bounded page sizes,
- adding caching for readonly admin metadata,
- keeping transactions small and deterministic,
- limiting large-response payloads and row counts.

## 5. What scales horizontally

This application can be adapted to a horizontally scaled deployment by:

- keeping the auth and financial authorization checks server-side in a stateless HTTP service,
- externalizing the session store and shared DB,
- separating background workers from request handling,
- placing a queue between external system actions and downstream processing,
- using a load balancer for multiple API replicas behind a single shared database.

## 6. Future migration path to Postgres or another production database

If demand grows substantially, the recommended migration is:

- keep the existing API contracts and domain-model semantics,
- replace SQLite with PostgreSQL or a managed relational database,
- preserve the same financial tables and constraints,
- add indexes and query plans tuned for the admin transaction center,
- move event-heavy and async workloads to worker processes or queue-based jobs,
- keep ledger invariants and idempotency keys in place during migration.

A minimal migration plan looks like this:

1. Export the current ledger, users, bot payments, and settings data into a staging environment.
2. Recreate the schema in PostgreSQL with equivalent constraints and indexes.
3. Verify data parity and referential integrity.
4. Update the server to use a pooled DB client.
5. Run traffic through a shadow or dual-write validation path before switching fully.

This keeps the core business logic stable while improving concurrency and operational resilience.

## 7. Background worker and queue migration path

If the workload becomes more event-driven, move asynchronous processing behind a queue:

- payment review events,
- audit log publication,
- referrals and commission calculations,
- analytics aggregation,
- scheduled cleanup of expired tokens and stale sessions.

A suitable progression is:

- local in-process queues for dev/testing,
- Redis or durable queue service for production,
- worker processes that consume jobs and update ledger state transactionally,
- a separate read-optimized replica for admin analytics and large reports when needed.

## 8. Trading intelligence posture

The project intentionally remains a paper-trading and demo environment. It does not claim guaranteed profits or guaranteed win rates. Real markets remain uncertain, and signal quality must remain selective rather than forcing trades.

The app should keep the following principles in place:

- only trade when the signal quality clears a minimum threshold,
- reject stale or malformed price data,
- use risk controls before trade submission,
- log decisions and outcomes to allow audit and review,
- keep backtest or simulation results clearly labeled as simulated rather than live performance.

## 9. Operational guidance

To keep the system production-safe as it grows:

- bound all page sizes and API query lengths,
- keep admin-only financial endpoints behind server-side ownership checks,
- avoid returning huge datasets to the browser,
- preserve idempotency and transactional integrity for monetary events,
- keep financial record creation and mutation logic centralized,
- avoid exposing secrets, wallet keys, session cookies, or auth material in logs or responses.

This project is already close to a secure local-first architecture and can scale substantially with incremental improvements without a risky rewrite.
