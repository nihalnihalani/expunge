# Backup and restore runbook

Tools: `infra/services/backup/backup-mongo.mjs`, `restore-mongo.mjs`, `restore-drill.mjs`. They use the pinned
`mongo:8.0.15@sha256:f4d54619...` image (mongodump 100.13.0) and read credentials only from environment variables.

## Principals (BLOCKED on Atlas)

- `EXPUNGE_BACKUP_URI`: a dedicated read-only principal over the three databases (world, control, private). It is not in
  `PRINCIPALS`, so no Atlas role is defined for it yet; create one with read on those databases plus `listCollections`/`listIndexes`
  through Atlas administration. It is never the setup principal and never a runtime principal. The private database holds sealed
  material: keep the archive's destination access-controlled and encrypted at rest.
- `EXPUNGE_RESTORE_URI`: a restore principal with write, `createCollection`, `collMod` and `createIndex` on the target databases.
  Use only from the operator machine.
- Atlas continuous or snapshot backup is the primary durable recovery and is **BLOCKED** (needs the Atlas project and tier). These
  logical dumps are the portable, tested second layer.

## Back up (SUPPORTED, drilled locally)

1. Quiesce writers: `docker compose -p expunge-node stop worker` (and `observer` if running). A dump is consistent per collection
   only; with writers running, cross-collection invariants (jobs vs effects vs receipts) can be torn.
2. `EXPUNGE_BACKUP_URI=... EXPUNGE_WORLD_DB=... EXPUNGE_CONTROL_DB=... EXPUNGE_PRIVATE_DB=... node infra/services/backup/backup-mongo.mjs --out <dir>`
   (add `--docker-network <net>` when the database is only reachable on a Docker network; the default is host networking).
3. Output: three `expunge-<stamp>.{world,control,private}.archive.gz` and `expunge-<stamp>.manifest.json` with per-archive sha256 and
   a fingerprint of the source (per collection: document count, order-independent document hash, validator hash, index hash).
4. Copy the set off the host; keep the manifest with the archives. Restart workers.

## Restore (SUPPORTED, drilled locally)

1. Stop every service that holds a runtime principal. Never restore under a running worker: leases and fences would race the data.
2. The target databases must be empty (a typo cannot overwrite live data: the tool refuses non-empty targets unless `--drop`, and
   requires the target names to be repeated in `--confirm-databases`). To recover in place, drop the damaged databases first from
   the operator machine; to recover beside, use `--map old=new,...` and repoint the services.
3. `EXPUNGE_RESTORE_URI=... node infra/services/backup/restore-mongo.mjs --manifest <file> --confirm-databases a,b,c`
4. The tool verifies each archive's sha256 against the manifest, restores with the same pinned image, then fingerprints the target and
   compares it with the manifest. Exit 0 means validators, indexes and every document hash are identical; exit 4 lists differences.
5. Run `npm run setup:mongo` once (idempotent) to re-assert validators, indexes and the authority rows, then start services.
6. Projection streams: clients that had read events newer than the backup hold a sequence the restored stream no longer has.
   `ProjectionRepository.resetStream(key, jobId, 'restore')` (setup principal) restarts a job's stream under a new epoch so
   clients re-page; **no script wraps it yet**. Until one exists, restart the operator and treat open job views as stale.
7. Do not replay Raindrop or provider side effects. Telemetry outbox rows restored in `sdk_enqueued`/`ingest_accepted` states are
   re-driven by the dispatcher's own ladder, which is idempotent per operation id.

## Drill (SUPPORTED)

```sh
# own replica set (copy packages/mongo/test/docker-compose.yml, add ulimits nofile 64000, port 127.0.0.1:27318)
docker compose -p expunge-rr -f <copy> up -d --wait
node infra/services/backup/restore-drill.mjs
```

It seeds throwaway databases through `scripts/setup-mongo.ts` and the repositories, backs up, drops the databases, restores,
compares validators/indexes/documents, proves the restored validators reject an invalid insert (code 121) and the unique index
rejects a duplicate (code 11000), and runs four negative controls (changed document detected, checksum mismatch refused,
non-empty target refused, wrong confirmation refused). It refuses a non-local URI and drops its databases at the end. Run it before
every release and after any change under `packages/mongo/src/validators*.ts` or `setup.ts`.

Limits: the drill is a local replica set with 16 seeded documents across 74 collections; it proves the tooling and the validator
and index round trip, not Atlas RBAC, Atlas sizes, or a restore time objective.
