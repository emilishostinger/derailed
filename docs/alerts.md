# Being told when something breaks

The whole anxiety of running your own server is *what if it falls over and I do not
find out*. **Settings → Tell me when something breaks** is the answer.

## Where it can send

| | |
| --- | --- |
| **My phone** | [ntfy](https://ntfy.sh). Install the app, subscribe to a topic nobody could guess, paste its address in. Free, no account anywhere |
| **Discord** | A webhook URL from Server Settings → Integrations |
| **Slack** | An Incoming Webhook URL |
| **Email** | Uses whatever is set up under Update emails |
| **Telegram** | Your chat id, plus a bot token from @BotFather |
| **Anything else** | A URL. Derailed posts JSON to it |

Add as many as you like. Each has a **Test** button that sends a real message
immediately, ignoring every rule below, so you find out the address is wrong now
rather than during an outage.

## What it will tell you about

On by default:

- An app crashes, and separately, an app that **keeps** crashing
- A deploy fails
- The disk is filling up, or memory is running out
- A certificate is about to expire, or a domain stops pointing here
- A backup fails, or [turns out not to restore](backups.md)

Off by default: **a deploy works.** A message every time something goes right is the
fastest way to teach yourself to ignore the messages, and then to miss the one that
mattered.

## How it avoids becoming noise

The hard part of a notifier is not sending. It is not sending.

- **The same problem is reported once.** An app crash-looping does not send forty
  messages; it sends one, and then one more about the loop, which is a different
  problem needing a different answer.
- **Recovery resets it.** When the app comes back up, the next time it falls over is
  news again. Without that, a problem fixed in the morning and returning at night
  would be silent, which is how people stop trusting alerts entirely.
- **A new failure is new.** The same deploy failing a *different* way is reported,
  because fixing one build error and hitting the next is exactly when you want telling.
- **Six hours of quiet** per problem, at most, before it can be raised again.

## What a message looks like

> **Ghost keeps crashing**
>
> It has stopped unexpectedly 4 times in the last few minutes, so it is not staying up
> long enough to be useful. It is in Newsroom.
>
> It is running out of memory. Give it a higher memory limit on its Settings tab, or
> add swap on the Server page.

What happened, what it means, and what to do. A notification that says
`container exited 137` and stops is one that made your phone buzz and left you no
better off.

## Privacy

Everything is sent by your server directly to the address you gave it. There is no
Derailed service in the middle, and nothing is sent anywhere you did not configure.

Bot tokens are encrypted at rest like every other secret and are never returned to the
browser. Saving the form without retyping one keeps the stored one.
