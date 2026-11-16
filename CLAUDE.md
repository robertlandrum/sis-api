# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SIS (Service Information System) is a CMDB alternative: a REST-over-HTTP API where
clients define their own object types (`schemas`) and then CRUD instances of them
(`entities`), with change history (`commits`), webhooks (`hooks`), key/value config
(`hiera`), RBAC, and optional custom server-side `scripts`. It is an Express 5 app
on modern Node (LTS, `engines: node >=22`) backed by MongoDB via Mongoose 8.

## Commands

Prereq: a local MongoDB on `localhost:27017` must be running for the server and the
full test suite. The test suite connects to `mongodb://localhost/sis-test`; override
with the `db__url` env var (nconf reads `__` as the nested-key separator), e.g.
`db__url="mongodb://localhost:27018/sis-test" npm test`.

- `npm install` - install deps (lockfile: `package-lock.json`).
- `npm start` / `node server.js` - run the server.
- `npm test` - run the mocha suite (config in `.mocharc.yml`).
- `npm run lint` - run eslint (flat config in `eslint.config.js`).
- `npm run typecheck` - `tsc` over the app code (`tsconfig.json`: `checkJs`, `noEmit`,
  not strict; the tests are not checked).
- `npm run coverage` - mocha under `c8`.
- CI: `.github/workflows/ci.yml` runs the lint, the type check and the suite on Node 22 and 24 against
  MongoDB 7 for pushes to `develop` / `main` and every pull request.
- `npm run build` - generate `build.json` (consumed by the `/info` endpoint).

The build/test tooling was migrated off the obsolete grunt + jshint + blanket stack
to npm scripts + `mocha` + `eslint` + `c8`. `.mocharc.yml` preloads
`scripts/gen-build-info.js` (writes `build.json`) and lists every spec.

### Running a single test

Tests use Mocha + `should` + `supertest`. `test/init-tests.js` should be listed first
because it starts the shared local server (via `test/fixtures/util.js` →
`server.startServer`) and seeds a `sistest_super` superuser; other specs reuse it.
`--no-config` keeps mocha from running every spec `.mocharc.yml` lists, so pass the
preload and `--exit` it would have:

```
db__url="mongodb://localhost/sis-test" ./node_modules/.bin/mocha --no-config \
  --require scripts/gen-build-info.js --timeout 60000 --exit \
  test/init-tests.js test/v1.1-api/test-api-entities.js
```

Relevant env vars:
- `SIS_REMOTE_URL` - point the suite at a remote SIS instead of spawning a local server.
- `db__url` - override the MongoDB connection string for a run.

## Architecture

The system is a strict three-layer stack. When adding or changing a resource, you
almost always touch a route + a manager, not raw Express/Mongoose.

1. **Routes / Controllers** (`routes/*.js`) - HTTP layer. Every route module exports
   `setup(app, config)`. Each defines a subclass of **`routes/apicontroller.js`**
   (`ApiController`) and calls `controller.attach(app, "/<base>")`. `attach` mounts the
   CRUD verbs under a version-prefixed path (`/api/:version(v1|v1.1)/<base>`), wraps all
   mutating verbs in token auth (`_wrapAuth`), and handles bulk ops, chunked JSON
   streaming of large arrays, CAS, upsert, commit logging, and hook dispatch. Subclasses
   mostly override `getManager`, `getType`, `convertToResponseObject`, and `applyDefaults`.

2. **Managers** (`util/*-manager.js`) - domain/DB layer, all ES classes extending
   **`util/manager.js`** (`Manager`), except `CommitManager` and `SessionManager`. A Manager owns a Mongoose model and implements
   validation, `applyUpdate`, RBAC authorization, references/joins, and the actual
   add/update/delete/getAll operations. Controllers delegate here; managers do not know
   about HTTP.

3. **Mongoose models** - built from SIS schema definitions, not hand-written per type.

### The schema/entity engine (the non-obvious core)

`util/schema-manager.js` is central and is created once in `server.js` after the Mongo
connection opens. On boot it calls `bootstrapEntitySchemas` to register SIS's own
internal schemas (users, tokens, hooks, hiera, schemas themselves - see
`util/sis-schemas.js`). At runtime, when a request hits `/api/v1.1/entities/:schema`,
`EntityController.getManager` asks `schemaManager.getEntityManager(name)`, which looks up
the user-defined schema document and **dynamically builds a Mongoose model and an
`entity-manager` for it on the fly**. So "tables" in SIS are data, created via the
`/schemas` API, not code. `schema-manager.js` also monkeypatches Mongoose `Document.init`/
`toObject` to tolerate schema changes (e.g. a field changing type) without crashing.

SIS internal metadata lives in the `_sis` subdocument on every object (`owner`, `locked`,
`immutable`, `tags`, `_created_by/_at`, `_updated_by/_at`); `_sis_references`,
`_sis_arraypaths`, `_sis_defaultpaths` are attached to schemas to drive joins, array
normalization, and populate behavior. See `docs/index.md` for the full field/endpoint model.

### Cross-cutting pieces

- **Auth**: Passport strategies in `routes/webutil.js` - a user/password strategy (to mint
  tokens via `Authorization: Basic`) and a token strategy (`x-auth-token` or
  `Authorization: Bearer`). Backends are `sis` (passwords stored in SIS) or `ldap`
  (Active Directory), selected by `app.auth_config`. RBAC is enforced in the managers;
  reads are open by design (unless `app.auth_reads`).
- **Sessions**: `POST /users/auth_token` returns an Ed25519-signed JWT from
  `util/session-manager.js` (not stored). Keys are `conf/keys/jwt-<kid>.{key,pub}`
  (`npm run gen-jwt-key`; tests use `test/fixtures/keys`). The user is still loaded per
  request, and `sis_users.session_gen` (bumped by logout `DELETE /users/auth_token` or a
  password change) invalidates sessions. Persistent tokens stay opaque in `sis_tokens`.
- **Versioning**: paths carry `:version` (`v1` deprecated, `v1.1` current, see
  `SIS.SUPPORTED_VERSIONS`).
- **Commits / history**: `util/commit-manager.js` records diffs (via `jsondiffpatch`) when a
  controller is configured with `log_commits`; exposes `/<resource>/:id/commits` and
  point-in-time `/revision/:utc`.
- **Hooks**: `util/hook-manager.js` fires outbound webhooks on create/update/delete when a
  controller is configured with `fire_hooks`.
- **Constants**: `util/constants.js` holds every option key, error factory (`SIS.ERR_*`),
  field name, and enum used across layers - read it before inventing strings.
  `ERR_INTERNAL` turns MongoDB duplicate key errors into `ERR_CONFLICT` (409, code 1005,
  naming the taken value) and sends other errors as their name and message only (the
  stack goes to the log); `ApiController.sendError` routes any non-tuple error through it,
  so no raw error reaches a client. The final error handler in `server.js` sends errors
  through `webUtil.toSisError` (SIS errors as they are, body parser errors with their
  4xx status, the rest as `ERR_INTERNAL`).
- **Indexes**: Mongoose builds a model's indexes in the background, and a write that gets
  ahead of a unique index is not checked (and then keeps the index from being built).
  `schemaManager.indexesReady(model)` waits for them: `getEntityManager` uses it before
  handing out a manager, and `server.js` waits for every model before it listens. Keep
  new write paths behind one of the two.
- **Shutdown**: hooks are dispatched after the response; `stopServer` waits for their
  lookups (`hook-manager.lookupsDone()`) so the connection can close cleanly.
- **Clustering**: when `app.use_cluster` is set, `server.js` forks a worker per CPU.

### Configuration

Config is resolved by `nconf` in `server.js` in this precedence: env vars (nested key
separator is `__`) → argv → `conf/config.json.local` → `conf/config.json`. (`config.js`
at the repo root is a standalone template, not loaded by the server.) Tests load
`test/fixtures/config.test.json`. The config shape (`db`, `server`, `app`, `logger`) is
documented in `README.md`.

### Admin tooling

`tools/useradmin.js` creates/updates/deletes users from the command line (needed to
bootstrap the first superuser, since the REST API requires an existing privileged user):
`node tools/useradmin.js update|delete /path/to/user.json`.

## Conventions

- The code is ES modules (`"type": "module"`): `import` at the top of a module with the
  `.js` extension on local paths, `export default` for a module's main export (the
  managers export their factory) and named exports for the rest - modules with only
  named exports, such as `routes/webutil.js` or `util/logger.js`, are imported as a
  namespace (`import * as webUtil from "./webutil.js"`). There is no `require`,
  `module`, `__dirname` or `"use strict"` (modules are strict); use
  `import.meta.dirname`, and read JSON with `fs`. The managers, controllers and
  endpoint code are ES classes (`class X extends Manager`, with `super(...)` and
  `super.method(...)`) and use `async` methods, `try`/`catch` around awaited calls and
  arrow callbacks instead of `var self = this`, and take no callbacks. The specs are
  `async` too. Write new code that way and cover it in the style of
  `test/test-manager.js` (`async` mocha tests, `await` on supertest requests and the
  `TestUtil` fixtures, and `TestUtil.expectError` for SIS error tuples). Assert in the
  test, not in a callback: a throw inside an express handler or a promise callback
  becomes a timeout instead of the failure.
- Controller handlers are `async (req, res)` methods wrapped by `_wrapAuth` /
  `_wrapReadAuth`, which authenticate and send whatever the handler throws. A handler
  hands `_finish(req, res, code, async () => result)` the work that resolves its result;
  `_finish` saves the commit, sends the result, dispatches the hooks and sends errors.
  Parse queries with `_parseValidQuery`, which sends the 400 for a `q` that is not JSON
  (`webUtil.ERROR_QUERY` is shared and frozen - never add conditions to it).
- The script client objects (`endpoints/api-client.js`, `api-response.js`) stay closures:
  they are cloned into each script's context. Results with more than one part are
  named objects, not arrays: `update`/`upsert` resolve with `{ old, updated }` (`old`
  is null when an upsert added the object), and bulk operations with
  `{ success, errors }`.
- Promises are **native** (`Promise`). The small `util/promises.js` helper provides
  `defer()` (a promise settled from events, as the endpoint workers need) and
  `nodeify(promise, cb)` (for callback APIs such as passport's verify functions).
- Mongoose 8 notes that bit during the upgrade and are worth remembering: query/model
  methods return promises (no callbacks); `ObjectId` instance strings are `"ObjectId"`;
  `strictQuery` is set to `false` (see `schema-manager.js`) so non-schema query paths
  (e.g. custom-type subpaths, join paths) are not stripped; `doc.set(obj, undefined,
  { merge: true })` is used so nested updates deep-merge; empty arrays satisfy
  `required`, so owner arrays use an explicit non-empty validator (`util/sis-schemas.js`).
- Express 5 notes: `req.query` is a re-parsing getter, so `server.js` snapshots it into a
  mutable own-property; the query parser is forced to `extended`; routes can't use inline
  regex or optional `:id?` (the `:version` param is validated via `app.param`).
- `lodash` v4 is the utility lib; match the style of the surrounding code (it still
  uses `var`).
- The local modules import each other without cycles - keep it that way. Imports load
  before a module's body runs, so do not read the configuration (`nconf`) while a module
  loads; loggers from `logger.createLogger` are made when first used, so creating them
  at load is fine.
- API docs live in `docs/*.md`; `samples/` holds example schema/entity/hook JSON payloads.
