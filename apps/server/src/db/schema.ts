/**
 * Numbered migrations, applied at boot inside a transaction and tracked in `_migrations`.
 * Never edit a migration that has shipped, append a new one.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        slug       TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE services (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind              TEXT NOT NULL CHECK (kind IN ('app','database')),
        name              TEXT NOT NULL,
        slug              TEXT NOT NULL,

        repo_url          TEXT,
        branch            TEXT,
        root_dir          TEXT,
        build_strategy    TEXT NOT NULL DEFAULT 'auto'
                            CHECK (build_strategy IN ('auto','dockerfile','nixpacks')),
        dockerfile_path   TEXT,
        port              INTEGER,
        health_path       TEXT NOT NULL DEFAULT '/',
        instances_desired INTEGER NOT NULL DEFAULT 1 CHECK (instances_desired IN (0,1)),
        memory_limit_mb   INTEGER,

        db_engine         TEXT,
        db_version        TEXT,
        db_name           TEXT,
        db_user           TEXT,
        db_password_enc   TEXT,
        exposed_port      INTEGER,

        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        UNIQUE (project_id, slug)
      );
      CREATE INDEX idx_services_project ON services(project_id);

      CREATE TABLE deployments (
        id             TEXT PRIMARY KEY,
        service_id     TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        status         TEXT NOT NULL CHECK (status IN (
                         'queued','cloning','detecting','building','starting','checking',
                         'routing','running','failed','canceled','superseded')),
        commit_sha     TEXT,
        commit_message TEXT,
        trigger        TEXT NOT NULL DEFAULT 'manual'
                         CHECK (trigger IN ('manual','redeploy','rollback','webhook')),
        image_tag      TEXT,
        container_id   TEXT,
        error_summary  TEXT,
        error_hint     TEXT,
        log_path       TEXT,
        created_at     INTEGER NOT NULL,
        started_at     INTEGER,
        finished_at    INTEGER
      );
      CREATE INDEX idx_deployments_service ON deployments(service_id, created_at DESC);

      CREATE TABLE env_vars (
        id         TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value_enc  TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','link','system')),
        UNIQUE (service_id, key)
      );

      CREATE TABLE links (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        to_service_id   TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        inject_as       TEXT,
        created_at      INTEGER NOT NULL,
        UNIQUE (from_service_id, to_service_id)
      );

      CREATE TABLE domains (
        id              TEXT PRIMARY KEY,
        service_id      TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        hostname        TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL CHECK (kind IN ('generated','custom')),
        dns_status      TEXT NOT NULL DEFAULT 'unchecked'
                          CHECK (dns_status IN ('unchecked','ok','wrong_ip','no_record')),
        tls_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK (tls_status IN ('pending','active','error','disabled')),
        last_checked_at INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_domains_service ON domains(service_id);

      CREATE TABLE volumes (
        id             TEXT PRIMARY KEY,
        service_id     TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        name           TEXT NOT NULL UNIQUE,
        container_path TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'image-sourced apps and remembered framework',
    sql: `
      -- 'repo' (clone and build) or 'image' (pull and run). Existing rows are repos.
      ALTER TABLE services ADD COLUMN source TEXT NOT NULL DEFAULT 'repo';
      ALTER TABLE services ADD COLUMN image TEXT;
      -- What detect.ts worked out, kept so the UI can show a real logo instead of
      -- re-deriving a guess it no longer has the repository for.
      ALTER TABLE services ADD COLUMN framework TEXT;
    `,
  },
  {
    id: 3,
    name: 'private repository tokens',
    sql: `
      -- Encrypted at rest, like every other secret. Never returned by the API.
      ALTER TABLE services ADD COLUMN repo_token_enc TEXT;
    `,
  },
  {
    id: 4,
    name: 'api tokens',
    sql: `
      -- Only the hash is stored, so a stolen database yields no working tokens.
      CREATE TABLE api_tokens (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `,
  },
  {
    id: 5,
    name: 'a backup schedule per project',
    sql: `
      -- 'off', 'daily' or 'weekly'. Per project, because "back up everything" and
      -- "back up the one that matters" are both reasonable, and only the owner knows
      -- which project is which.
      ALTER TABLE projects ADD COLUMN backup_schedule TEXT NOT NULL DEFAULT 'off';
    `,
  },
  {
    id: 6,
    name: 'domains can exist before they belong to an app',
    sql: `
      -- A domain is something you own and point at this server. Which app answers on
      -- it is a later decision, and often a different one next month. SQLite cannot
      -- drop NOT NULL in place, so the table is rebuilt.
      CREATE TABLE domains_new (
        id              TEXT PRIMARY KEY,
        service_id      TEXT REFERENCES services(id) ON DELETE SET NULL,
        hostname        TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL CHECK (kind IN ('generated','custom')),
        dns_status      TEXT NOT NULL DEFAULT 'unchecked'
                          CHECK (dns_status IN ('unchecked','ok','wrong_ip','no_record')),
        tls_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK (tls_status IN ('pending','active','error','disabled')),
        last_checked_at INTEGER,
        created_at      INTEGER NOT NULL
      );

      INSERT INTO domains_new
        SELECT id, service_id, hostname, kind, dns_status, tls_status, last_checked_at, created_at
        FROM domains;

      DROP TABLE domains;
      ALTER TABLE domains_new RENAME TO domains;
      CREATE INDEX idx_domains_service ON domains(service_id);
    `,
  },
  {
    id: 7,
    name: 'apex and www as one address',
    sql: `
      -- The other half of a pair. Set on the name that redirects, pointing at the
      -- name people should see, so example.com and www.example.com stop being two
      -- unrelated rows that happen to look alike.
      ALTER TABLE domains ADD COLUMN redirect_to TEXT REFERENCES domains(id) ON DELETE SET NULL;
    `,
  },
  {
    id: 8,
    name: 'traffic, counted per app',
    sql: `
      -- Counted from the proxy's own access log, rolled up as it arrives. Raw lines
      -- are never kept: they are the visitors' business, not ours.
      CREATE TABLE traffic_hourly (
        service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        hour_start  INTEGER NOT NULL,
        requests    INTEGER NOT NULL DEFAULT 0,
        bots        INTEGER NOT NULL DEFAULT 0,
        bytes       INTEGER NOT NULL DEFAULT 0,
        ms_total    INTEGER NOT NULL DEFAULT 0,
        ok_2xx      INTEGER NOT NULL DEFAULT 0,
        redirect_3xx INTEGER NOT NULL DEFAULT 0,
        client_4xx  INTEGER NOT NULL DEFAULT 0,
        server_5xx  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service_id, hour_start)
      );

      -- One row per visitor per hour, hashed with a per-server key. Enough to count
      -- people without being able to name them, and dropped with everything else.
      CREATE TABLE traffic_visitors (
        service_id   TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        hour_start   INTEGER NOT NULL,
        visitor_hash TEXT NOT NULL,
        PRIMARY KEY (service_id, hour_start, visitor_hash)
      );

      CREATE TABLE traffic_paths (
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        day_start  INTEGER NOT NULL,
        path       TEXT NOT NULL,
        requests   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service_id, day_start, path)
      );

      CREATE TABLE traffic_referrers (
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        day_start  INTEGER NOT NULL,
        referrer   TEXT NOT NULL,
        requests   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service_id, day_start, referrer)
      );
    `,
  },
  {
    id: 9,
    name: 'a command for images that need one',
    sql: `
      -- Some images are a toolbox with no default job: the Hermes agent's entrypoint
      -- expects "gateway run" after it, and without that the container starts, prints
      -- its help and exits. Stored as a JSON array so an argument may contain a space.
      ALTER TABLE services ADD COLUMN command TEXT;
    `,
  },
  {
    id: 10,
    name: 'deploy when a new release is published',
    sql: `
      ALTER TABLE services ADD COLUMN deploy_on_release INTEGER NOT NULL DEFAULT 0;
      -- The tag last seen on GitHub, whether or not it was deployed. Set when the
      -- setting is switched on, so turning it on adopts today's release as the
      -- starting point rather than immediately shipping whatever is already out.
      ALTER TABLE services ADD COLUMN last_release_tag TEXT;

      -- 'release' is a new kind of trigger and the column checks its own values, so
      -- the table has to be rebuilt to widen it. Copied rather than renamed, because
      -- a rename would leave the old CHECK attached to the new name.
      CREATE TABLE deployments_new (
        id             TEXT PRIMARY KEY,
        service_id     TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        status         TEXT NOT NULL CHECK (status IN (
                         'queued','cloning','detecting','building','starting','checking',
                         'routing','running','failed','canceled','superseded')),
        commit_sha     TEXT,
        commit_message TEXT,
        trigger        TEXT NOT NULL DEFAULT 'manual'
                         CHECK (trigger IN ('manual','redeploy','rollback','webhook','release')),
        image_tag      TEXT,
        container_id   TEXT,
        error_summary  TEXT,
        error_hint     TEXT,
        log_path       TEXT,
        created_at     INTEGER NOT NULL,
        started_at     INTEGER,
        finished_at    INTEGER
      );
      INSERT INTO deployments_new SELECT
        id, service_id, status, commit_sha, commit_message, trigger, image_tag,
        container_id, error_summary, error_hint, log_path, created_at, started_at,
        finished_at
      FROM deployments;
      DROP TABLE deployments;
      ALTER TABLE deployments_new RENAME TO deployments;
      CREATE INDEX idx_deployments_service ON deployments(service_id, created_at DESC);
    `,
  },
];
