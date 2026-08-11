# Quick start

From a bare server to a website people can visit. About five minutes, most of it
waiting for a build.

## 1. Install

On a fresh Linux server, as root:

```sh
sudo sh install.sh
```

See [installing](install.md) for what that does and how to run it without prompts.
Open the URL it prints and create your account.

## 2. Put the dashboard behind a domain

Do this before anything else. Until you do, you sign in over plain HTTP and your
password crosses the internet in the clear.

1. At your domain provider, add an `A` record for something like
   `panel.example.com` pointing at your server's IP address.
2. In Derailed: **Domains → Dashboard address**, type the name, save.

Derailed checks the record really points here before switching, then gets a
certificate. From then on the dashboard is `https://panel.example.com`.

## 3. Make a project

A project is a group of things that belong together: an app and its database, usually.
Click **New project** and name it after the thing you are building.

## 4. Add something

Three ways in, all from the **New** button:

- **Paste a GitHub link.** Any public repository. Derailed reads it, says in plain
  language what it found, and builds it. A Dockerfile is used if there is one;
  otherwise the build is worked out for you.
- **Upload a website.** Drag in a zip. A folder of HTML is served as it is, a folder of
  PHP gets PHP and Apache, and anything else is built like a repository would be.
- **Choose a ready-made app.** WordPress, Gitea, Nextcloud and seventeen others, each
  with its database and storage set up in one click.

Watch the deploy stream past. When it says the app is live, it has answered a health
check and traffic has been pointed at it.

## 5. Visit it

Every app gets an address the moment it first goes live, before you configure any DNS:
something like `myapp.203-0-113-7.sslip.io`. It works immediately and is plain HTTP.

To get the padlock, use a domain you own:

1. **Domains → Add a domain**, type `example.com`.
2. Derailed tells you the exact `A` record to add. Add it at your provider.
3. When it sees the record, choose which app answers on it.

The certificate arrives on its own, usually within a minute.

## 6. Keep it safe

- **Storage.** If your app writes files it needs to keep, add storage on its **Storage**
  tab. Without it, a redeploy starts from a fresh container and those files are gone.
  Derailed warns you before a deploy that would do this.
- **Backups.** On the **Backups** page, set a project to be backed up daily. A backup is
  an ordinary `.tar.gz` with a SQL dump and a tar per stored folder, and you can
  download it and take it elsewhere.

## Finding things

The search box at the top of every page, or `⌘K`, reaches everything: a project, an
app, a domain, a page of this handbook, and actions like deploying. It searches the
handbook's text and not only its titles, so "sql dump" or "nixpacks" finds the page
that explains it.

## What next

- [Deploying](deploying.md): branches, build settings, rollback
- [Domains and HTTPS](domains.md): www, redirects, giving every app a name on your domain
- [Databases](databases.md): connecting one to your app
- [Coding agents](mcp.md): let Claude Code or Cursor drive all of this for you
