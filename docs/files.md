# Files, and letting apps send email

## The Files tab

There is one **Files** tab, under Tools, and what it shows depends on what the app is,
because "my files" means two different things:

- **A dragged-in site** has no separate source: the files you uploaded *are* the site.
  So Files lists them, opens any of them in a real editor, and **Save and publish**
  writes the change and redeploys through the ordinary pipeline. One button adds a
  custom 404 or 500 page. Fixing a typo stops meaning editing at home and dragging the
  whole folder in again.
- **Every other app** (built from a repository or an image) has no editable source:
  its code lives in git or the image, and an editor that wrote to a checkout the next
  deploy throws away would be a lie with a save button. So Files is its **storage**
  instead: the folders attached as storage, which are the only places whose contents
  survive a deploy, with browse, upload, download, rename, delete, and the same editor.
- **A dragged-in site that also has attached storage** gets a small switch between
  *Site files* and *Stored data*, so neither is hidden.

The editor is the same everywhere: syntax highlighting for whatever language the file
is, line numbers, and Cmd-S (or Ctrl-S) to save, because the muscle memory is
universal. Binary files (images, fonts) are replaced by uploading a new one, not
edited as text.

### Pages for when things go wrong

The editor's first plain-language use is one button: **Add a 404 page** (and a 500).
A file called `404.html` or `500.html` at the site's root is automatically wired up
as the page visitors actually see for those errors, on both static and PHP sites. No
setting, no new noun: the file being there is the ask. The button starts you from a
clean, self-contained page, self-contained because an error page that loads a
stylesheet is an error page with a second chance to fail.

The [visitor figures](analytics.md) count which pages people looked for and did not
find, which is usually the reason to reach for this.

## Browsing an app's files

Every app with storage has a **Files** tab: browse it, upload, download, rename, delete,
make a folder, and open a text file to edit it.

For anybody who came from cPanel or Plesk this is the first thing they will look for,
and it is the last real reason to open a terminal for a WordPress site: a theme to
upload, an `uploads` folder to look inside, a config file to read.

### What it can reach

Only the folders attached as **Storage**. Not the whole container.

That is deliberate. Those are the only places anything is meant to be written and the
only places whose contents survive a deploy, so they are the only places worth editing.
A browser rooted at `/` would also be a way to read every process's environment out of
the container, and there is already a Terminal tab for anybody who means to do that.

Paths containing `..` are refused outright rather than resolved. Nothing legitimate
needs one, and resolving is where the subtle mistakes live.

### Editing

Files up to 512 KB open in a text box. Anything larger is a download, not something to
put on a page.

Saving writes to a temporary file and moves it into place, so a failure half way
through leaves the original rather than a truncated one.

### Uploading and downloading

Drag files onto the list, or use **Upload**. Both work; a file browser whose only route
to uploading is a drag is one that half the people using it will think cannot upload.
Uploads go one at a time so the count means something, and up to 200 MB each.

An upload **replaces** a file of the same name. That is what somebody re-uploading a
corrected file means, and the alternative is a folder full of `style (2).css`.

Uploaded files and new folders are given the **same owner as the folder they land in**.
This matters more than it sounds: a theme that lands owned by `root` is a theme
WordPress cannot then write to, and nothing on the page would say why.

**Download** on a file streams it straight out of the container. Nothing is held on the
server on the way through, so a large database dump downloads fine, and the bytes are
the bytes: a PNG comes back identical, which it would not if anything on the path
treated it as text.

### Renaming and deleting

Both are on the `⋯` menu at the end of a row, and on right-click. Renaming stays in the
same folder. Deleting a folder takes everything in it.

**Files have no undo.** Apps, databases and projects go to the trash and can be put back
for seven days; a file inside a running container has nowhere to go, so the confirmation
says so plainly rather than implying an undo that the rest of Derailed has trained you
to expect.

The storage folder itself cannot be renamed or deleted here. It is a mount point, and
removing it would leave the app pointed at a folder that is no longer there. Remove
storage on the **Storage** tab, where it is clear that the data goes with it.

The browser is for apps, not databases. A database keeps its data in a volume too, but
its files on disk are the engine's own business: editing them by hand corrupts it, and a
member deleting one would be the irreversible loss that deleting the storage is kept to an
owner to prevent. So the tab is not offered for a database, and the routes behind it
refuse one. Look inside a database through **Browse**, and keep copies through snapshots
and backups.

## Letting an app send email

Every self-hosted app needs to send email and almost every one fails at it: WordPress
password resets, Gitea invitations, Vaultwarden verification. It is the number one
"I installed it and it half works" complaint in self-hosting, and the reason is always
that nobody has an SMTP server.

Derailed already has one configured, for its own notifications. **Access → Sending
email** hands the same settings to an app.

It sets the usual variables:

```
SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_PASSWORD  SMTP_SECURE  SMTP_FROM  SMTP_URL
MAIL_HOST  MAIL_PORT  MAIL_USERNAME  MAIL_PASSWORD  MAIL_ENCRYPTION
MAIL_FROM_ADDRESS  MAIL_FROM_NAME
```

Several spellings at once on purpose. No two apps agree on what to call these, and
somebody who has never heard of SMTP cannot reasonably be asked to work out which one
their app wants. Setting six an app ignores costs nothing; setting the wrong one leaves
a password reset that silently never arrives.

They appear on the **Variables** tab like anything else, so you can see them, change
them, or add whatever else your app needs. Anything you set by hand is never
overwritten.

**Redeploy the app afterwards.** Variables are given to a container when it starts.

### One thing it cannot do

If Derailed is set to send **from this server** rather than through a provider, this is
unavailable and says so. That mode has no credentials at all: Derailed hands each
message straight to the recipient's mail server, and an app cannot borrow something
that does not exist. Set up a mail provider under Settings and it becomes available.
