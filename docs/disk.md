# Disk space

A full disk on a small server breaks everything at once and quietly. Builds fail
somewhere unhelpful, databases refuse to write, the proxy cannot renew a certificate.
Docker is nearly always the reason.

The **Server** page shows what is using the disk, in words, and offers one button.

## What is using it

| | What it is | Can it go? |
| --- | --- | --- |
| **App images** | Every version of every app you have deployed, kept so a rollback is instant | The ones nothing is running, yes |
| **Build leftovers** | Scraps from past builds | Yes. It only makes the next build slower |
| **Stopped containers** | Containers that have finished | The ones Derailed made, yes |
| **Half-finished builds** | Checkouts left behind by builds that were interrupted | Yes |
| **Backups** | Your backups | **Never automatically.** Change retention on the Backups page |
| **Build logs** | What was printed during past deploys | Tidied up on their own |

The figure beside each one is what it is using. The second figure, where there is one,
is how much of that nothing would miss.

## Freeing up space

**Server → Free up space** removes unused images, build scraps, and stopped containers
Derailed created. It says how much it expects to get back before you press it, and how
much it actually got afterwards.

It is deliberately narrow. It never touches:

- **Volumes**, which is where your apps keep their data
- **Backups**, whose whole purpose is to still be there
- **Anything unlabelled**, so other software on the machine is left alone
- **Images that are running**, obviously

If you want the aggressive version, `docker system prune -a` on the server still
exists. Derailed's button is the one you can press without reading up first.

## Warnings

Derailed checks hourly and says something when the disk passes **80%**, and says it
more urgently past **90%**. It also refuses to start a build when there is less than
2 GB free, because a build that runs out of room half way through fails with an error
about something else entirely.

## Swap

Most cheap VPS images ship with no swap file. On a server with 1 or 2 GB of memory
that matters more than it sounds: when memory runs out the kernel does not warn you,
it picks the process using the most and kills it. The symptom is an app that "randomly
restarts", which is close to impossible to work out from the dashboard.

If the Server page sees no swap and under 4 GB of memory, it offers to add some. The
file is sized at twice your memory for small machines, written to `/swapfile`, turned
on, and added to `/etc/fstab` so it survives a reboot. Without that last part it would
work until the first restart and then quietly stop, which is worse than never having
had it.

There is nothing to undo: swap costs disk space and nothing else. To remove it by hand:

```sh
swapoff /swapfile && rm /swapfile
sed -i '/swapfile/d' /etc/fstab
```

## Doing it yourself

```sh
docker system df           # the same figures, unfriendlier
du -sh /var/lib/derailed/* # what Derailed itself is storing
```
