# Notes for the Chrome Web Store review

The “Testing instructions” field in the developer dashboard is limited to 500
characters, which is not enough for an extension that needs a server. This page
is the long form it links to. It is public and contains no real user data.

Contact for questions during the review: **bede.berger@gmail.com**

---

## Why credentials are needed at all

Schreibwerkstatt is a self-hosted writing app; this extension is its browser
companion and has no bundled backend. It cannot be exercised without a server,
so I run a public demo instance. It holds sample data only — no real user
content — and these credentials are meant to be shared.

## Setup (about one minute)

1. Right-click the extension icon and choose “Options” (the options page also
   opens from the gear icon in the popup).
2. Server address:  `https://demo.schreibwerkstatt.app`
   Device token:    `swd_a053dcf5c8a40ff401d627be20ffed97f1af2598808ad70799913811f7780010`
3. Click “Save”.
4. Click “Grant access to this host”. Chrome will ask for the host permission
   for this single origin. This is expected and required — see the host
   permission justification. The manifest deliberately contains no `<all_urls>`;
   the address of a self-hosted app differs per user and cannot be declared in
   the manifest, so it is requested at runtime for exactly one origin.
5. Click “Test connection”. Two books load: **Beispiel: Die Verwandlung** (owned
   by the demo account) and **Fremdes Buch** (owned by another account, where
   the demo user has read-only access). Read-only books are shown greyed out
   rather than hidden, so it is visible why they cannot be captured into.
6. Pick **Beispiel: Die Verwandlung** as the default book.

## Optional: seeing the result in the app

The extension only sends; the receiving app is a separate web application. If
you would like to confirm that a capture really arrives, you can sign in to the
demo instance and look:

- <https://demo.schreibwerkstatt.app/login>
- E-mail: `demo@demo.schreibwerkstatt.app`
- Password: `DfAo9j2YjeGSG-wk`

Open the book you captured into; the entry is listed there with the metadata the
extension harvested. The same account’s settings page (Settings › Devices) is
where the device token above was issued, so you can also see how a user obtains
one — and revoke it, which makes the extension report an authentication error
rather than fail silently.

This login is offered for convenience only. The extension itself never asks for
a password and cannot use one: it authenticates solely with the device token,
which is scoped to capturing and cannot read manuscript text or delete anything.

## What to test

**A) Capture a page.** Open any article, e.g.
<https://en.wikipedia.org/wiki/Citation>. Click the extension icon (or press
Alt+Shift+S). The form is pre-filled from the page’s own metadata — title,
authors, journal, year, DOI, URL, access date, body text — and shows where each
field came from. Press “Send”.

**B) Capture a quote.** Select a sentence on that page, right-click, choose
“Capture as quote” (or press Alt+Shift+Q). A notification appears with an Undo
button. If you press Undo within 6 seconds, no server record is created at all;
the request is only sent after the undo window closes.

**C) Error handling.** In the capture form, switch the book to **Fremdes Buch**
and press “Send”. That book belongs to another account and the demo user has
read-only access there, so the server refuses the write. The extension reports
precisely why, naming both the reason and the error code:

> You may only read this book (role: viewer). Capturing needs editor rights —
> the book’s owner grants those. (INSUFFICIENT_ROLE)

The item stays in the visible queue and is never discarded silently. Every
failure message in the extension names its error code, so a problem can be
traced without guesswork.

**D) Offline queue (optional).** Change the server address to an unreachable
host and capture a page. The item goes into a retry queue with exponential
backoff and is shown on the toolbar badge. Nothing is ever dropped silently.

## Notes for review

- **No remote code.** Nothing is loaded or executed from a remote source; the
  Content Security Policy in the manifest allows `'self'` only. The code in the
  package is neither minified nor obfuscated.
- **No default server, no third party.** Network traffic goes exclusively to the
  host entered in step 2. There is no analytics, no telemetry and no
  third-party endpoint. Apart from relative API paths, the package contains no
  hardcoded address — verifiable by grepping the package for `http`.
- **No persistent content script.** The harvesting script is injected via
  `activeTab` at the moment of a user action only.
- **Source code:**
  <https://github.com/schreibwerkstatt/browser-extension>
