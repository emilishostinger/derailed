# Pictures the right size

A four-megabyte photo on a page that shows it four hundred pixels wide is the
commonest reason a small site feels slow, and the fix usually involves learning
about image formats, build plugins, or an image CDN with a pricing page. None of
that is knowledge anyone wanted.

One switch per app, **Pictures the right size** on its Settings tab, and one address
shape:

```
/_img/photo.jpg?w=800
```

Whatever `/photo.jpg` is, `/_img/photo.jpg?w=800` is the same picture 800 pixels
wide, re-encoded, and served as WebP to browsers that say they take it, the original
format to the rest. Leave `?w=` off and the picture is re-encoded without resizing.
That is the entire interface: change the `src` in your pages and you are done.

## How it works

One shared [imgproxy](https://imgproxy.net) sidecar (libvips underneath) is started
the first time any app turns the switch on. The proxy rewrites `/_img/…` requests
into the sidecar's grammar and dials it over the internal network; the sidecar
fetches the original from your app's own container. Nothing new is exposed to the
internet, and the sidecar has no published ports at all.

Resized pictures are served with year-long `Cache-Control` headers, so each
visitor's browser caches them: a picture is resized once per person, not once per
view. Honestly said: the caching lives in the browser, not on the server, so the
very first request for each size does the work.

## The guard rails

- The width must be one to four digits. Anything else is ignored and the picture is
  served unresized, because the width is interpolated into a URL and a "width" of
  `800/plain/http://somewhere-else` must never get the chance to mean something.
- The sidecar will only fetch from Derailed-managed containers. Pointed at any
  other address, it refuses, so it cannot be walked to the machine's private
  network however a URL is crafted.
- Pictures sit behind the same access rules as pages: a password-protected site's
  pictures are exactly as private as its pages.
- Absurdly large originals are refused before they are decoded, because a
  50-megapixel file is a memory spike wearing a beach photo's name.
