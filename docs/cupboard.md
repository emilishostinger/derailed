# The computer in your cupboard

Derailed has always assumed a rented VPS with a public address. An old laptop or a
mini PC on a shelf is a $0/month server with more memory than the VPS, and the only
thing it lacks is reachability. This page is how it gets it, without port forwarding,
without DNS knowledge, and without any relay run by us: the moment your uptime
depends on somebody else's infrastructure, "it's yours" is a lie, so Derailed rides
[Tailscale](https://tailscale.com) (free for personal use) and never sits in the path.

## Private by default

**Settings → Reach this server from anywhere.** Three presses the first time:

1. **Install Tailscale on this server**, the official installer, same as the Derailed
   installer brought Docker.
2. **Connect to your tailnet**: either open the sign-in link on any device that is
   already yours, or paste an auth key from the Tailscale admin console.
3. **Use the tailnet address for app links**, so every app gets a working address
   (`myapp.100-x-y-z.sslip.io`) that resolves for every device on your tailnet.

That is the whole thing. The dashboard and every app are now reachable from your
phone, your laptop, the office, anywhere, and the open internet is never involved. A
database stays private the way it always was; nothing changed except who can reach
the machine.

Honest print: the tailnet addresses are plain HTTP, like all sslip.io addresses. On a
tailnet the wire is already encrypted between your devices (WireGuard underneath), so
the padlock's job is being done a layer down; the browser just does not know it.

## Public when wanted

**Share one app with the whole internet** uses Tailscale Funnel: pick the app, and it
gets real HTTPS at your machine's `ts.net` name, certificate and all, with no ports
opened on your router and no relay of ours. Behind the scenes it is one domain row
pointing the `ts.net` name at the app, and the funnel handing traffic to the same
proxy that serves everything else, so passwords, logins, bots walls and forms all
work on it unchanged.

The first time, Tailscale asks for one approval in its admin console (Funnel is off
per-tailnet by default). One app per machine, because a machine has one `ts.net`
name; for a second public app, give it a real domain and a real server, or a
Cloudflare tunnel by hand, which works fine in front of the same proxy.

## What still needs a public server

Let's Encrypt certificates for your own domains need the internet to reach port 80,
and email reputation needs a clean public address. A cupboard box does apps,
databases, backups and the whole dashboard; the moment you want `shop.example.com`
with a padlock for strangers, that is what the $6 VPS is for, and
[moving](moving.md) is one file.
