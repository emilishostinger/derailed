# Forms

A folder of HTML gets working forms with no backend, no third-party service and no
account. Add one attribute:

```html
<form data-derailed="contact">
  <input name="email" type="email" required>
  <textarea name="message"></textarea>
  <button>Send</button>
</form>
```

What people submit lands in the app's **Messages** tab, with an email to the server's
owners if [email is set up](files.md). A contact form, an RSVP list, a "tell me when it
launches" box: the three things every small site wants and usually rents from a third
party that puts its own logo in the confirmation.

## How it works

A static site cannot answer a POST; there is nothing behind it to answer with. So the
proxy that already serves every page catches the POST instead and hands it to
Derailed, which keeps it. During the deploy of a dragged-in or repository site,
Derailed also gives each `data-derailed` form the two mechanical bits the markup
implies: a `method="post"` if none is written, and a hidden field carrying the form's
name, so the Messages tab can tell the contact form from the RSVP list.

It is on by default for dragged-in folders, and a switch on the Messages tab for
everything else. An app with its own backend should usually leave it off: catching is
per-app and catches **every** POST, which is exactly right for a site that answers
none and exactly wrong for an app that answers its own.

## The optional fields

All optional, all plain inputs:

- `_redirect`: a path on your own site to send people to after submitting, like
  `/thanks.html`, instead of the plain "Message sent" page. Only a path; another site
  dressed as one is refused.
- `_gotcha`: the spam filter. Add it hidden with CSS (`style="display:none"`); people
  never see it, bots fill it in, and a submission with anything in it is quietly
  thrown away, while the bot is thanked as warmly as anyone.

```html
<input name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
```

## The honest limits

- Each visitor can send a few messages a minute, and a message is capped at sixty
  fields and 64 KB. Enough for any form a person fills in; boring for a script.
- File uploads are not kept. A form that includes one still works; the files are
  dropped and the text arrives.
- The honeypot catches the casual bots, which is most of them. It is not a CAPTCHA and
  does not claim to be; a determined spammer aims at you specifically, and for that
  the per-visitor limit is the real fence.
- **Download as CSV** on the Messages tab exports everything, with formula-shaped
  values defused so a message cannot run code in your spreadsheet.
- If the site has a password in front of it, the forms are behind the same password.
