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
  {
    id: 11,
    name: 'deploy when a commit is pushed',
    sql: `
      ALTER TABLE services ADD COLUMN deploy_on_push INTEGER NOT NULL DEFAULT 0;
      -- The commit last seen at the top of the branch, whether or not deploying it
      -- worked. Recorded before the build starts on purpose: if it were only written
      -- on success, one commit that fails to build would be redeployed every couple
      -- of minutes, for ever, and the build queue would never be empty again.
      ALTER TABLE services ADD COLUMN last_pushed_sha TEXT;

      -- 'push' joins the list, and the column checks its own values, so the table is
      -- rebuilt to widen it. 'webhook' stays: it has never been produced by anything,
      -- but a CHECK that a stored row fails is a database that will not open.
      CREATE TABLE deployments_new (
        id             TEXT PRIMARY KEY,
        service_id     TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        status         TEXT NOT NULL CHECK (status IN (
                         'queued','cloning','detecting','building','starting','checking',
                         'routing','running','failed','canceled','superseded')),
        commit_sha     TEXT,
        commit_message TEXT,
        trigger        TEXT NOT NULL DEFAULT 'manual'
                         CHECK (trigger IN ('manual','redeploy','rollback','webhook','release','push')),
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
  {
    id: 12,
    name: 'deleting something is not the end of it',
    sql: `
      -- Deleting an app used to destroy its stored folders along with it, which is
      -- the one action here that could lose work nobody could get back. Now a delete
      -- sets a time, the containers stop, and everything that holds data stays where
      -- it is until the trash is emptied a week later.
      --
      -- Null means "not deleted", which keeps every existing row correct and lets the
      -- unique indexes below ignore deleted rows for free.
      ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
      ALTER TABLE services ADD COLUMN deleted_at INTEGER;

      CREATE INDEX idx_projects_deleted ON projects(deleted_at);
      CREATE INDEX idx_services_deleted ON services(deleted_at);
    `,
  },
  {
    id: 13,
    name: 'who is allowed to see this app',
    sql: `
      -- A username and a bcrypt hash, both stored on the service, because "only
      -- people with this password can see this site" is a property of the site and
      -- not of an account on this server. Caddy does the checking.
      ALTER TABLE services ADD COLUMN auth_user TEXT;
      ALTER TABLE services ADD COLUMN auth_hash TEXT;
      -- A JSON array of addresses and ranges. Empty or null means everyone.
      ALTER TABLE services ADD COLUMN allow_from TEXT;
      -- When set, visitors get a "back shortly" page instead of the app.
      ALTER TABLE services ADD COLUMN maintenance INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 14,
    name: 'things that run on a schedule',
    sql: `
      -- Cron for people who do not know what cron is. The schedule is kept as a real
      -- cron expression because that is the thing with well-defined semantics, and
      -- the plain-language choices in the UI compile down to one of a handful of them.
      --
      -- A job with no service_id runs on the server rather than inside a container:
      -- that is the "tidy up every night" case, and it is deliberately a different
      -- shape rather than a magic service id.
      CREATE TABLE jobs (
        id           TEXT PRIMARY KEY,
        service_id   TEXT REFERENCES services(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        command      TEXT NOT NULL,
        schedule     TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        last_run_at  INTEGER,
        next_run_at  INTEGER,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_jobs_service ON jobs(service_id);
      CREATE INDEX idx_jobs_next ON jobs(next_run_at);

      -- Every run keeps what it printed. A scheduled job whose output goes nowhere is
      -- a job nobody can tell has been quietly failing for a month.
      CREATE TABLE job_runs (
        id          TEXT PRIMARY KEY,
        job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        exit_code   INTEGER,
        output      TEXT,
        trigger     TEXT NOT NULL DEFAULT 'schedule'
      );
      CREATE INDEX idx_job_runs_job ON job_runs(job_id, started_at DESC);
    `,
  },
  {
    id: 15,
    name: 'what things looked like an hour ago',
    sql: `
      -- CPU and memory were live-only, which meant "was it slow last night?" and
      -- "is this getting worse?" were both unanswerable. One row per service per
      -- hour, with the average and the peak, because an average alone hides exactly
      -- the spike somebody is looking for.
      CREATE TABLE metrics_hourly (
        service_id     TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        hour_start     INTEGER NOT NULL,
        samples        INTEGER NOT NULL DEFAULT 0,
        cpu_total      REAL NOT NULL DEFAULT 0,
        cpu_peak       REAL NOT NULL DEFAULT 0,
        memory_total   INTEGER NOT NULL DEFAULT 0,
        memory_peak    INTEGER NOT NULL DEFAULT 0,
        memory_limit   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service_id, hour_start)
      );
    `,
  },
  {
    id: 16,
    name: 'one domain, several apps',
    sql: `
      -- A domain pointed at one app, which is right until you want example.com/blog
      -- to be a different thing from example.com. Nobody thinks in "reverse proxy
      -- rules"; everybody thinks "I want my blog at /blog".
      --
      -- The hostname was UNIQUE, which is exactly what makes that impossible, so the
      -- table is rebuilt: uniqueness now belongs to the pair. SQLite cannot change a
      -- column constraint in place.
      --
      -- Null path means the whole domain, which is every row that already exists.
      -- COALESCE in the index because SQLite treats every NULL as distinct, so two
      -- whole-domain rows for one hostname would otherwise both be allowed.
      CREATE TABLE domains_paths (
        id              TEXT PRIMARY KEY,
        service_id      TEXT REFERENCES services(id) ON DELETE SET NULL,
        hostname        TEXT NOT NULL,
        path_prefix     TEXT,
        kind            TEXT NOT NULL CHECK (kind IN ('generated','custom')),
        dns_status      TEXT NOT NULL DEFAULT 'unchecked'
                          CHECK (dns_status IN ('unchecked','ok','wrong_ip','no_record')),
        tls_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK (tls_status IN ('pending','active','error','disabled')),
        last_checked_at INTEGER,
        created_at      INTEGER NOT NULL,
        redirect_to     TEXT REFERENCES domains_paths(id) ON DELETE SET NULL
      );

      INSERT INTO domains_paths
        (id, service_id, hostname, path_prefix, kind, dns_status, tls_status,
         last_checked_at, created_at, redirect_to)
      SELECT id, service_id, hostname, NULL, kind, dns_status, tls_status,
             last_checked_at, created_at, redirect_to
      FROM domains;

      DROP TABLE domains;
      ALTER TABLE domains_paths RENAME TO domains;

      CREATE INDEX idx_domains_service ON domains(service_id);
      CREATE UNIQUE INDEX idx_domains_host_path
        ON domains(hostname, COALESCE(path_prefix, ''));
    `,
  },
  {
    id: 17,
    name: 'is it up, and was it',
    sql: `
      -- Uptime Kuma ships as a one-click template here, which is an admission that
      -- this belongs in the product. One row per check per domain, kept for ninety
      -- days, which is the window a status page shows.
      CREATE TABLE uptime_checks (
        id          TEXT PRIMARY KEY,
        domain_id   TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        at          INTEGER NOT NULL,
        up          INTEGER NOT NULL,
        status_code INTEGER,
        ms          INTEGER,
        reason      TEXT
      );
      CREATE INDEX idx_uptime_domain ON uptime_checks(domain_id, at DESC);
    `,
  },
  {
    id: 18,
    name: 'a second factor, and a record of who did what',
    sql: `
      -- One password guards a machine that can run anything. TOTP because it is
      -- universal and needs no hardware; the secret is encrypted like every other.
      ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
      ALTER TABLE users ADD COLUMN totp_confirmed_at INTEGER;
      -- Single-use codes for the day the phone is lost, stored only as hashes.
      CREATE TABLE recovery_codes (
        id       TEXT PRIMARY KEY,
        user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hash     TEXT NOT NULL,
        used_at  INTEGER
      );

      -- Where a session was opened, so the list of them means something.
      ALTER TABLE sessions ADD COLUMN user_agent TEXT;
      ALTER TABLE sessions ADD COLUMN ip TEXT;
      ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;

      -- "Who deleted the database?" is impossible to answer retroactively and cheap
      -- to answer in advance.
      CREATE TABLE audit_log (
        id      TEXT PRIMARY KEY,
        at      INTEGER NOT NULL,
        user_id TEXT,
        email   TEXT,
        action  TEXT NOT NULL,
        subject TEXT,
        detail  TEXT,
        ip      TEXT
      );
      CREATE INDEX idx_audit_at ON audit_log(at DESC);
    `,
  },
  {
    id: 19,
    name: 'apps that sleep when nobody is looking',
    sql: `
      -- On a small server this is what lets somebody run twelve side projects rather
      -- than four. Minutes of quiet before pausing; null means never sleep, which is
      -- what every existing app should keep doing.
      ALTER TABLE services ADD COLUMN sleep_after_minutes INTEGER;
      -- When the proxy last saw a request for it, so "quiet" means something.
      ALTER TABLE services ADD COLUMN last_seen_at INTEGER;
    `,
  },
  {
    id: 20,
    name: 'a copy of an app, per branch',
    sql: `
      -- The flagship feature of every platform people pay for, and every piece was
      -- already here: git polling, per-service containers, wildcard routing.
      --
      -- A preview is an ordinary service that knows which app it is a copy of and
      -- which branch it follows. Ordinary, so every existing screen works on it
      -- without being taught anything, and it is torn down when the branch goes.
      ALTER TABLE services ADD COLUMN preview_of TEXT REFERENCES services(id) ON DELETE CASCADE;
      CREATE INDEX idx_services_preview ON services(preview_of);

      -- Whether an app makes copies of its branches at all. Off unless asked for.
      ALTER TABLE services ADD COLUMN preview_branches INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 21,
    name: 'more than one person',
    sql: `
      -- One admin was right for v1 and wrong the moment a freelancer wants to hand a
      -- client access, or two friends share a box.
      --
      -- The default is 'owner' on purpose: every account that exists before this
      -- migration was the only account, and quietly demoting somebody out of their
      -- own server would be the worst possible way to learn this feature shipped.
      ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';

      -- Who invited whom, so the People list can say where an account came from.
      ALTER TABLE users ADD COLUMN invited_by TEXT REFERENCES users(id) ON DELETE SET NULL;
    `,
  },
  {
    id: 22,
    name: 'choose what the status page shows',
    sql: `
      -- Which addresses appear on the public status page.
      --
      -- NULL means "decide by kind", which is what every existing domain gets: the
      -- ones you bought are shown, the automatic ones are not. That default is not
      -- arbitrary. An automatic address has the server's IP written into it, so
      -- publishing one tells the internet where the machine is.
      --
      -- It was also the reason people switched the status page on and got an empty
      -- page with no explanation, so it is now a choice rather than a rule: 1 or 0
      -- here overrides the default, and the screen says what the trade is.
      ALTER TABLE domains ADD COLUMN on_status_page INTEGER;
    `,
  },
  {
    id: 23,
    name: 'queries worth keeping',
    sql: `
      -- The query box was a box you typed into and then lost. The query somebody
      -- actually wants is the same three every time: how many signups today, which
      -- orders are stuck, what did that job write. Retyping them from memory is the
      -- reason people give up and install a client instead.
      --
      -- Kept per database rather than per person: the useful queries are about the
      -- shape of the data, and a second owner arriving should find them already there.
      CREATE TABLE saved_queries (
        id         TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_saved_queries_service ON saved_queries(service_id);
    `,
  },
  {
    id: 24,
    name: 'and a list of who is not welcome',
    sql: `
      -- The allow list answers "only these people". The question people actually
      -- arrive with is the opposite one: a single address hammering the login page,
      -- or one bot ignoring robots.txt. An allow list cannot express that without
      -- listing every visitor you have ever had.
      --
      -- Checked before the allow list, so an explicit block wins. That is the reading
      -- that never surprises anybody: a name on the "not welcome" list is not welcome.
      ALTER TABLE services ADD COLUMN block_from TEXT;
    `,
  },
  {
    id: 25,
    name: 'set it once for the whole project',
    sql: `
      -- An API key, a timezone, a Sentry address: things that are true of the whole
      -- project rather than of one app in it. Setting the same value on five apps by
      -- hand is five chances to fat-finger one of them, and rotating it later means
      -- finding all five and remembering which they were.
      --
      -- Kept in its own table rather than as rows on services with a null service_id,
      -- because the unique constraint that stops one app having two of the same
      -- variable is exactly the one that would have to be given up to allow it.
      CREATE TABLE project_env (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value_enc  TEXT NOT NULL,
        UNIQUE (project_id, key)
      );
    `,
  },
  {
    id: 26,
    name: 'telling something else what happened',
    sql: `
      -- There is already a webhook *alert channel*, and it is a different thing: it
      -- posts the same prose a human would read in Discord, only fires for alerts
      -- that are switched on, and is deduplicated so the same problem twice is said
      -- once. All three are right for a person and wrong for a program.
      --
      -- This is for wiring Derailed into something: a stable event name, structured
      -- fields, every occurrence, and a signature so the receiver can tell it is
      -- really us.
      CREATE TABLE webhooks (
        id           TEXT PRIMARY KEY,
        url          TEXT NOT NULL,
        -- Encrypted at rest like every other secret, and never sent to the browser.
        secret_enc   TEXT,
        -- JSON array of event names, or NULL meaning every event there is.
        events       TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        -- What happened last time, so the screen can say whether this works without
        -- anybody having to go and look at the other end.
        last_at      INTEGER,
        last_status  INTEGER,
        last_error   TEXT
      );
    `,
  },
  {
    id: 27,
    name: 'which pages are slow, and who is here now',
    sql: `
      -- The path tally counted requests and nothing else, so "which page is slow" had
      -- no answer at all: the timing was in the hourly roll-up, which has no idea what
      -- was asked for. A sum and a count rather than an average, because averages
      -- cannot be added together and these rows are merged across days.
      ALTER TABLE traffic_paths ADD COLUMN ms_total INTEGER NOT NULL DEFAULT 0;

      -- Visitors were kept per hour, which answers "how many people today" and cannot
      -- answer "how many people right now". A minute is fine enough to be live and
      -- coarse enough that the table does not grow faster than the hourly one did.
      CREATE TABLE traffic_live (
        service_id   TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        minute_start INTEGER NOT NULL,
        visitor_hash TEXT NOT NULL,
        PRIMARY KEY (service_id, minute_start, visitor_hash)
      );
      CREATE INDEX idx_traffic_live_minute ON traffic_live(minute_start);
    `,
  },
  {
    id: 28,
    name: 'a ceiling per project',
    sql: `
      -- A memory limit existed per app, and had to be set per app, which means it was
      -- set on the app somebody was already worried about and on none of the others.
      -- The app that takes the box down is by definition the one nobody expected.
      --
      -- A ceiling for everything in a project is the version people will actually
      -- use: one number, set once, applying to whatever gets added later.
      ALTER TABLE projects ADD COLUMN memory_limit_mb INTEGER;

      -- Thousandths of a core, so half a core is 500 and there is no floating point
      -- anywhere near a value that ends up in a container spec.
      ALTER TABLE projects ADD COLUMN cpu_limit_millis INTEGER;
    `,
  },
  {
    id: 29,
    name: 'a copy of a database more often than nightly',
    sql: `
      -- "The bad thing happened at three and the backup is from midnight" is the
      -- worst hour of somebody's month, and the answer to it is not a bigger nightly
      -- backup. It is more of them.
      --
      -- Deliberately not the same thing as a project backup: this is one database,
      -- kept on a short rolling window, so it stays small enough to take often.
      CREATE TABLE db_snapshots (
        id         TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        at         INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        file       TEXT NOT NULL
      );
      CREATE INDEX idx_db_snapshots_service ON db_snapshots(service_id, at DESC);

      -- How often, in hours. NULL is off, which is the default: taking copies of
      -- somebody's database on a schedule they did not ask for is their disk.
      ALTER TABLE services ADD COLUMN snapshot_every_hours INTEGER;
    `,
  },
  {
    id: 30,
    name: 'a used two-factor code cannot be used twice',
    sql: `
      -- A TOTP code is valid for a whole 30-second step, and Derailed allows one step
      -- either side for a slow phone clock, so a six-digit code shoulder-surfed or read
      -- off a proxy was good for a minute and a half and for as many sign-ins as anyone
      -- could type in it. Remembering the last step a person actually signed in with,
      -- and refusing anything at or before it, makes a code good exactly once.
      ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
    `,
  },
  {
    id: 31,
    name: 'updates that take a backup first',
    sql: `
      -- Updating an app is three promises kept in order: a copy taken first, the new
      -- version checked before it takes over, and the old one kept ready to come back.
      -- Each row here is one update, with the way back written down: the backup that
      -- was taken and the exact image (by digest, not by tag, because the tag now
      -- means the new version) that was running before.
      CREATE TABLE app_updates (
        id          TEXT PRIMARY KEY,
        service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        status      TEXT NOT NULL,
        trigger     TEXT NOT NULL DEFAULT 'manual',
        backup_id   TEXT,
        from_ref    TEXT,
        to_ref      TEXT,
        message     TEXT,
        created_at  INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX idx_app_updates_service ON app_updates(service_id, created_at DESC);

      -- Per app, off by default. Backup-before-update is deliberately not a setting:
      -- it is what updating is. The only choice offered is whether it happens without
      -- being asked.
      ALTER TABLE services ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 0;

      -- 'update' and 'auto-update' join the trigger list, and the column checks its
      -- own values, so the table is rebuilt to widen it, same as when 'push' joined.
      CREATE TABLE deployments_new (
        id             TEXT PRIMARY KEY,
        service_id     TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        status         TEXT NOT NULL CHECK (status IN (
                         'queued','cloning','detecting','building','starting','checking',
                         'routing','running','failed','canceled','superseded')),
        commit_sha     TEXT,
        commit_message TEXT,
        trigger        TEXT NOT NULL DEFAULT 'manual'
                         CHECK (trigger IN ('manual','redeploy','rollback','webhook','release',
                                            'push','update','auto-update')),
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
  {
    id: 32,
    name: 'databases that grow up safely',
    sql: `
      -- A major-version upgrade is the same three promises as updating an app, with
      -- one more thing worth writing down: the old engine is kept, stopped but whole,
      -- for a week. Each row records what moved, the copy taken first, and exactly
      -- which stopped container and volume are being kept so the cleanup a week later
      -- removes the right things and nothing else.
      CREATE TABLE db_upgrades (
        id            TEXT PRIMARY KEY,
        service_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        from_version  TEXT NOT NULL,
        to_version    TEXT NOT NULL,
        snapshot_id   TEXT,
        old_container TEXT,
        old_volume    TEXT,
        status        TEXT NOT NULL,
        message       TEXT,
        created_at    INTEGER NOT NULL,
        finished_at   INTEGER,
        cleanup_after INTEGER,
        cleaned_at    INTEGER
      );
      CREATE INDEX idx_db_upgrades_service ON db_upgrades(service_id, created_at DESC);

      -- Postgres alone can shrink "how much do I lose" from an interval to seconds,
      -- by archiving its write-ahead log. Off by default: it is disk spent on every
      -- write, which is a decision, not a nicety.
      ALTER TABLE services ADD COLUMN wal_archive INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 33,
    name: 'a service can keep the name its neighbours call it',
    sql: `
      -- A compose file's services find each other by their written names, and those
      -- names allow characters a slug does not (my_db). The import keeps the original
      -- as an extra network alias, so an app whose configuration says my_db:5432
      -- still finds its database without anybody editing anything.
      ALTER TABLE services ADD COLUMN alias TEXT;

      -- Not everything in a compose file speaks HTTP: a Redis, a worker, a queue
      -- consumer. Holding those to "answer on a port or be thrown away" would fail
      -- every one of them at deploy time. 'http' is what every app already means;
      -- 'started' means the container staying up is the answer.
      ALTER TABLE services ADD COLUMN health_check TEXT NOT NULL DEFAULT 'http';
    `,
  },
  {
    id: 34,
    name: 'forms on any site',
    sql: `
      -- A folder of HTML gets working forms with no backend, no service and no
      -- account: the proxy catches the POST a static site could never answer, and
      -- what was submitted lands here, one row per message, the fields as JSON.
      CREATE TABLE form_submissions (
        id         TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        form       TEXT NOT NULL,
        data       TEXT NOT NULL,
        ip         TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_form_submissions_service ON form_submissions(service_id, created_at DESC);

      -- Per app. On for dragged-in folders from now on, because they are who this is
      -- for; off elsewhere, because an app with its own backend answers its own POSTs.
      ALTER TABLE services ADD COLUMN forms INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
