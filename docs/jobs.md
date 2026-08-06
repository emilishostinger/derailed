# Things that run on a schedule

Every app has a **Scheduled** tab. It runs a command inside that app, on a schedule,
with the app's files and its variables, exactly as if you had typed it on the Terminal
tab.

This is what WordPress cron, nightly cleanups, "email me a report" and
`php artisan schedule:run` all need, and until now none of them were possible.

## Setting one up

Two questions: **what to run**, and **how often**.

The command goes through a shell, so pipes, `&&` and redirection all work. The
schedule is a set of choices rather than five asterisks:

- Every 15 minutes
- Every hour
- Every day at 03:00
- Every Monday at 03:00
- Something else, where you can write a cron expression

## The cron expression, if you want one

Five fields: minute, hour, day of month, month, weekday. `*` for any, a number, a
list (`1,15`), a range (`9-17`), or a step (`0-30/10`).

```
0 3 * * *      every day at 03:00
*/15 * * * *   every fifteen minutes
0 4 1 * *      the first of every month, at 04:00
30 2 * * 1     Mondays at 02:30
```

Sunday is `0`, and `7` also works because every other cron accepts it.

**One inherited oddity worth knowing.** When you restrict *both* day-of-month and
weekday, cron treats them as "or", not "and". `0 0 1 * 5` means *the first of the
month, **or** any Friday*, not "Fridays that fall on the first". Derailed behaves the
same way, because behaving differently from every other cron in the world would be a
worse surprise.

## What happened

Every run keeps what it printed, both normal output and errors, in the order they came
out. The last twenty are kept per job.

A job whose output goes nowhere is a job that can be quietly failing for a month with
nothing to notice, so a scheduled run that exits non-zero also raises an
[alert](alerts.md).

**Run now** runs it immediately whatever the schedule says, which is also the way to
do a one-off task: make the job, run it by hand, and pause or delete it afterwards.

## Timing

Checked every thirty seconds, so a job fires within about half a minute of its time.
Runs do not overlap: if a sweep is still going when the next one is due, the next one
waits. That is what stops a job which takes longer than its own interval turning into
a queue that never empties.

A job whose app is not running records that it could not run, rather than failing
silently.

Anything still going after thirty minutes is stopped.

## Jobs that belong to the server

A job with no app attached runs on the server itself rather than inside a container.
That is the "tidy up every night" case. Through the API only for now:

```sh
curl -X POST https://your-dashboard/api/jobs \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"serviceId":null,"name":"Nightly tidy","command":"docker image prune -f","schedule":"0 4 * * *"}'
```
