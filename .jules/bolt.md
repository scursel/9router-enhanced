# Bolt's Performance Journal

## 2025-03-20 - Batching metadata fetches in modal components
**Learning:** React modal components that trigger multiple separate API fetch effects on `isOpen` cause 4+ sequential render cascades and non-concurrent network requests. Consolidating into a single `Promise.all` effect batches state updates and parallelizes network round-trips.
**Action:** Always fetch modal metadata concurrently via `Promise.all` and update state in a single batch on open.
