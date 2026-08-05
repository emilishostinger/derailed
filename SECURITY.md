# Security

## Reporting something

For anything that is not already public, please use GitHub's private vulnerability
reporting on this repository, or contact the maintainer directly. Do not open a public
issue for an unpatched vulnerability.

This is a young project with one maintainer. Expect a reply within a few days, and
please say plainly how bad you think it is.

## What is protected, and what is not

[docs/security.md](docs/security.md) has the full picture, including an explicit list of
what this does not protect you from. The short version:

- Passwords are argon2id. Sessions are opaque, `HttpOnly`, `SameSite=Lax`.
- API tokens are stored only as hashes.
- Database passwords, repository tokens and environment values are encrypted at rest,
  which protects the database file if it is copied off the machine and nothing more.
  Someone who is already root on the machine can read the key too.
- Apps are containers. Containers are isolation, not a sandbox.
