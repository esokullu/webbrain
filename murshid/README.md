# Murshid

*Mürşid* (Ottoman Turkish, from Arabic مرشد): one who shows the way.

Murshid is a Chromium browser, built on Electron, with WebBrain built in:

- **Tabs, like Chrome.** Tab strip with drag to reorder, reopen closed tab, an
  address bar that searches, downloads, find in page, zoom, print, devtools and
  the usual keyboard shortcuts.
- **WebBrain preinstalled.** The extension in `../src/chrome` is loaded into
  every profile. The toolbar's WebBrain button opens its side panel, docked in
  the window and resizable; per-tab panels follow the tab you are on.
- **WebBrain's new tab page preinstalled**, and switched on for new profiles.
- **A wallet.** The toolbar's Wallet button opens it in the side panel:
  Bitcoin and Ethereum from one recovery phrase, and websites can sign you in
  with it through `window.ethereum`. See [The wallet](#the-wallet).
- **WebBrain Companion in the system tray.** Murshid starts
  `../webbrain-systray` in the background (`--background`, no panel) when it is
  installed or bundled and not already running. The tray app is the Go
  companion, not part of the Electron process.
- **Ad and tracker blocking**, on by default, with EasyList, EasyPrivacy and
  uBlock's Unbreak list (see below).

The homepage is in `web/`.

## The address bar

The address bar completes as you type, like Chrome's:

- **Inline completion.** Type the start of a site you have typed before, or
  visited at least twice, and the rest of its address is filled in and
  selected. Keep typing to replace it, Backspace to drop it, or Enter to go.
  After a `/` it completes whole pages.
- **Suggestions.** The list under the address bar holds what Enter will do,
  then open tabs ("Switch to this tab"), pages from your history, your past
  searches and the search engine's suggestions. Up/Down and Tab move through
  it; Esc closes it and puts back what you typed; Shift+Delete removes the
  highlighted history entry; Alt+Enter opens in a new tab; Ctrl+Enter turns
  `example` into `www.example.com`.

History is kept in `<profile>/murshid-history.json` (up to 5,000 pages, the
least used dropped first) and never leaves the computer. Search suggestions
send what you type to the chosen search engine, without cookies; skipped for
addresses with a scheme, local and private hosts and file paths, and switched
off entirely with *Show search suggestions* in Settings, where history can be
cleared too.

The list is its own small view (`app/omnibox-popup.js`, `app/ui/popup.*`)
because the tab views are drawn above the browser chrome; matching and
ranking are in `app/omnibox.js`, the history store in `app/history.js`.

## Ad and tracker blocking

Murshid blocks ads and trackers by default, with
[Ghostery's adblocker library](https://github.com/ghostery/adblocker)
(`@ghostery/adblocker`, MPL-2.0) and these filter lists:

| List | Source | Licence |
|---|---|---|
| EasyList, by the EasyList authors | `https://easylist.to/easylist/easylist.txt` | GPL-3.0-or-later or CC BY-SA 3.0 ([licence](https://easylist.to/pages/licence.html)) |
| EasyPrivacy, by the EasyList authors | `https://easylist.to/easylist/easyprivacy.txt` | GPL-3.0-or-later or CC BY-SA 3.0 |
| uBlock filters – Unbreak, by the uBlock Origin contributors ([uAssets](https://github.com/uBlockOrigin/uAssets)) | `https://ublockorigin.github.io/uAssets/filters/unbreak.txt` | GPL-3.0 ([licence](https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE)) |

The lists are used as published; Murshid ships them, compiled into the
library's engine format, under the GPL-3.0.

- **How.** Electron keeps one listener per webRequest event and session, and
  Murshid's are in `app/identity.js` (client hints, and WebBrain's
  `chrome.webRequest`), so the library's `enableBlockingInSession()` is not
  used. Those listeners ask `app/adblock/` instead: `onBeforeRequest` cancels
  what a list blocks, and `onHeadersReceived` adds a list's `$csp` policy to a
  page as a header of its own, so the site's own policy still applies. Element
  hiding (`##` rules) comes from the library's Electron preload
  (`@ghostery/adblocker-electron-preload`), in top frames, answered by
  `app/adblock/`. Not applied: scriptlets (`+js`), procedural selectors, HTML
  filtering and `$removeparam`. `$redirect` filters cancel the request, as
  Chromium refuses the library's `data:` stand-ins.
- **Never filtered:** pages themselves (a listed site still opens), Murshid's
  own pages and requests (search suggestions, downloads, list updates), and
  anything from an extension: WebBrain's worker, side panel, offscreen
  documents and new tab page. Only the browsing session is filtered; other
  sessions are not. WebBrain's `chrome.webRequest` still sees a blocked
  request, ending in `onErrorOccurred` with `net::ERR_BLOCKED_BY_CLIENT`, as
  in Chrome.
- **Turning it off:** Settings → *Block ads and trackers*, or for one site,
  untick *Block ads on <site>* in the ⋮ menu on it (the tab reloads; the
  sites are kept in `adblockAllowedSites` in the settings file). The library
  hides no elements on IP addresses and `localhost`.
- **Lists offline, and updates.** `app/adblock/engine.bin.gz` is a prebuilt
  engine, described by `app/adblock/lists.json` (list versions, library
  engine version), so blocking works offline from the first run. Once the
  lists in use are a day old, Murshid downloads them again in a session of its
  own (no cookies), parses them in a utility process and keeps the result in
  `<profile>/adblock/`. A failed update is retried an hour later, and a
  download that is not a filter list is never used.
- **Rebuilding the bundled engine:** `npm run adblock`. Do it after upgrading
  `@ghostery/adblocker`, since a stored engine loads only with the library
  version that wrote it (`npm test` checks), and before releases, so new
  installs start with recent lists.
- **Tests:** `test/adblock.test.cjs` (in `npm test`) runs the real
  webRequest listeners against a small engine. `npm run test:adblock` starts
  Murshid with a fresh profile and checks, against real ad and tracker host
  names pointed at a local server: blocking, element hiding, what WebBrain's
  `chrome.webRequest` sees, its side panel, the ⋮ menu item and the Settings
  switch. With `MURSHID_TEST_ADBLOCK_REFRESH=1` it also downloads the lists.

Ghostery's Electron wrapper, `@ghostery/adblocker-electron`, is not a
dependency: Murshid would use nothing of it but its preload, which is a
package of its own, and importing it switches off Electron's security
warnings for the whole app (`ELECTRON_DISABLE_SECURITY_WARNINGS`).

## Run it

```sh
cd murshid
npm install
npm start
```

`npm start` loads WebBrain straight from `../src/chrome`, so it always runs the
extension at your checkout's HEAD. `MURSHID_PROFILE=<folder>` uses a separate
profile (handy for testing first-run behaviour); `MURSHID_DEBUG=1` mirrors the
extension worker's console to the terminal. Extension warnings and errors are
always written to `<profile>/logs/extensions.log`.

## The wallet

The Wallet button next to WebBrain opens Murshid's wallet in the side panel,
for every tab of the window, in place of WebBrain's panel while it is open.

- **One recovery phrase, two kinds of address.** A new wallet is 12 BIP39
  words from the system's secure random source; an existing 12 or 24 word
  phrase can be restored. It gives one Bitcoin address (BIP84, `bc1q…`) and one
  Ethereum address (BIP44, `m/44'/60'/0'/0/0`, the same as MetaMask) used on
  Ethereum, Arbitrum One, OP Mainnet, Base, Polygon and the Sepolia test
  network. Native coins only: no tokens, swaps, bridges or hardware wallets.
- **Receive, balance, send.** Three columns, side by side when the panel is
  wide and stacked when it is narrow. A transfer is built first and shown with
  its fee, and signed only after *Send now*. Bitcoin spends only confirmed
  coins, opts in to replace-by-fee and sends change back to the same address;
  *Send all* sends everything but the fee.
- **Kept on this computer.** The phrase is stored only encrypted, in
  `<profile>/murshid-wallet.json`: scrypt (N=2¹⁷, r=8, p=1) turns the password
  into an AES-256-GCM key. Keys are derived on unlock and live only in the
  main process; the wallet page never sees them. The wallet locks after 30
  minutes without use and when Murshid quits.
- **Websites.** While a wallet exists, top-level `http(s)` pages get
  `window.ethereum` (EIP-1193, also announced through EIP-6963). A site sees
  the Ethereum address only after the user connects it, and only while the
  wallet is unlocked. Connecting, `personal_sign`, `eth_signTypedData_v4`,
  `eth_sendTransaction` and network switches wait in the panel for approval,
  which opens by itself; the approve button stays off for a moment so a
  request cannot land under a click meant for something else. The panel flags
  sign-in messages (EIP-4361) for another domain, permits, unlimited token
  approvals and transactions expected to fail. `eth_sign` is refused; read-only
  calls go to the network's node. Connected sites are listed under *More*.
- **Network.** Balances, fees and broadcasts use public endpoints with no
  account (mempool.space and Blockstream for Bitcoin; PublicNode and each
  chain's own RPC for the rest), through a session of their own with no cookies.
  They see the wallet's addresses and the computer's IP address.

The code is in `app/wallet/` (`store.js` the wallet, `provider.js` what sites
may ask, `install.js` the IPC, `provider-preload.js` `window.ethereum`) and
`app/pages/wallet.*` (the panel). `npm test` covers the keys, encryption,
transfers and site requests; `npm run test:wallet` drives the panel and a
local test page in Electron with a fresh profile.

## How WebBrain runs inside Electron

Electron supports only part of the Chrome extension API.
[electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell)
adds `tabs`, `windows`, `action`, `contextMenus`, `cookies`, `notifications`,
`webNavigation` and friends. Murshid fills in what WebBrain still needs, in
`app/crx/`:

| API | How Murshid provides it |
|---|---|
| `chrome.sidePanel` | Per-tab and per-window panels as a docked `WebContentsView` (`setOptions`, `open`, `close`, `setPanelBehavior`, `getLayout`, `onOpened`/`onClosed`). |
| `chrome.debugger` | Bridged to `webContents.debugger` (CDP 1.3): `attach`, `detach`, `sendCommand`, `getTargets`, `onEvent`, `onDetach`, with Chrome's error texts. |
| `chrome.tabs.captureVisibleTab` | `webContents.capturePage()`, PNG or JPEG. |
| `chrome.offscreen` | A hidden window in the same session. |
| `chrome.downloads` | The session's real downloads (`download`, `search`, `pause`/`resume`/`cancel`, `erase`, `open`, `show`, events). |
| `chrome.tabGroups`, `chrome.tabs.group` | Group ids are kept so callers work; there is no group UI yet. |
| `chrome.identity.launchWebAuthFlow` | A sign-in window that stops at `https://<id>.chromiumapp.org/`. |
| `chrome.search.query` | Murshid's search engine setting. |
| `chrome.runtime.getContexts`, `runtime.lastError` | Answers for side panels and offscreen documents; `lastError` set for Murshid's own callback APIs. |

`preload-pre.js` runs in extension workers and pages before
electron-chrome-extensions' preload (which freezes `chrome`), `preload-post.js`
after it. `bridge.js` is the main-process side. While Murshid runs it keeps
WebBrain's service worker alive, so a run waiting on a model reply is not cut
off by the 30-second idle timeout.

Not there yet: `chrome.tabCapture`, `chrome.identity.getAuthToken`,
`contextMenus.update` (a no-op in electron-chrome-extensions), a tab-group UI,
the PDF viewer's MIME handler, and Chrome Web Store installs.

## Layout

```
app/
  main.js          startup, session, extension loading, IPC for the chrome UI
  window.js        one browser window: tabs, side panel, layout
  tab.js           one tab (a WebContentsView)
  crx/             extension API bridge (see above)
  ui/              the browser chrome: tab strip, toolbar, panel header
  pages/           murshid://newtab, settings, about, error, wallet
  commands.js      shortcuts (before-input-event on Windows/Linux, app menu on macOS)
  menu.js          app menu, ⋮ menu, tab menu
  downloads.js     download tracking shared by the toolbar and chrome.downloads
  companion.js     find and start WebBrain Companion
  wallet/          the wallet: keys, networks, window.ethereum (see above)
  permissions.js   site permission prompts
  identity.js      user agent and client hints; owns the session's webRequest listeners
  adblock/         ad and tracker blocking: lists, engine, bundled engine (see above)
  i18n.js          interface language, strings, right-to-left layout
  locales/         en, tr, ar, fa: Murshid's own strings
assets/
  icons/           app icon, .ico, PNGs, macOS template images
scripts/
  art/halftone.py  print the homepage pictures as gold halftone
  art/halftone.mjs run halftone.py with a Python that has OpenCV
  art/sources/     those pictures, with where they came from
  art/icon.mjs     draw the icon SVGs (the fez)
  build-icons.mjs  rasterize the icon (PNG, ICO, template images, favicons)
  copy-art.mjs     copy the icon into web/
  copy-fonts.mjs   copy the self-hosted fonts into web/fonts
  serve.mjs        static server for web/ and assets/
  build-adblock.mjs  rebuild app/adblock/engine.bin.gz from the filter lists
vendor/companion/  WebBrain Companion builds to bundle (not committed)
web/               the Murshid homepage
```

## Languages

Murshid's own interface (menus, dialogs, tab strip, toolbar and the
`murshid://` pages) is in English, Turkish, Arabic, Persian, Hindi, Azerbaijani,
Hebrew, Greek, Russian and Ukrainian. WebBrain and its
new tab page have their own translations and their own language setting.

- **Which language:** Settings → Language. "Automatic" uses the language
  Chromium picked from the system, or English if Murshid doesn't have it. A
  language picked there is also passed to Chromium as `--lang` at startup, so
  native menus and dialogs follow it. Changing it needs a restart.
- **Right to left:** Arabic, Persian and Hebrew mirror the tab strip and toolbar, and put
  the WebBrain side panel on the left. Chromium mirrors the window frame itself
  when its own locale reads right to left (caption buttons move left, and child
  view positions flip). `app/window.js` and `app/ui` allow for that, because the
  frame and the interface can read in different directions: "Automatic" on a
  Hebrew system, for example, or macOS, where the system language decides the frame.
- **Strings:** `app/locales/<code>.js`, one flat object per language, with
  `{name}` placeholders. `en.js` is the reference: every language has exactly
  its keys and placeholders. Menus and dialogs call `t()` in the main process.
  The browser chrome gets its strings from its preload (`data-t-*` attributes in
  `ui/index.html`). Pages are templates (`{{t:key}}`, and `{{rich:key}}` for
  *emphasis*), filled in by `app/protocol.js` before they are served.
- **Adding a language:** copy `en.js`, translate it, add it to `DICTIONARIES`
  and `NATIVE_NAMES` in `app/i18n.js`, and to `RTL` if it reads right to left.
  `npm test` checks the keys, the placeholders and, for Persian, the Persian
  ی/ک and half spaces. The website follows the same ten languages; see
  `scripts/i18n/README.md`.

## Application updates

Murshid 0.1.3 and newer check `https://murshid.one/updates/stable.json` at
startup and once a day. Automatic checks can be disabled in Settings. The
Updates page is available from the application menu, the ⋮ menu, About,
or `murshid://updates/`. A toolbar button appears when an update is available.
Checks do not download or install anything.

On packaged macOS builds, **Download update** uses Electron's native
Squirrel.Mac updater. It verifies the signed application and the update ZIP's
published SHA-256 and size. Once ready, **Restart and install** installs the
update. Windows, Linux and development builds open their platform's verified
release URL in the default browser so the installer can be downloaded and run.
Versions older than 0.1.3 require one manual installation to gain this feature.

For a macOS release, build both the DMG and ZIP:

```sh
npx electron-builder --mac dmg zip --universal --publish never
```

Stage the installer assets and their `SHA256SUMS.txt` under `web/download/`,
then run `npm run updates:feed`. This validates each selected asset and writes
`web/updates/stable.json`, including the native macOS ZIP and each platform's
own latest published version. Upload the feed and assets together with the
localized website. The feed must never advertise files that have not been
uploaded. `npm run test:updates` tests the real Updates page and IPC with an
isolated profile and a simulated future release.

## Package it

```sh
npm run pack   # unpacked app in dist/ (quick check)
npm run dist   # installers: NSIS (Windows), DMG (macOS), AppImage + deb (Linux)
```

The WebBrain extension is copied into `resources/extensions/webbrain`. To
bundle the Companion, put its build for the target in
`vendor/companion/<platform>-<arch>/` first (see the README there); it lands in
`resources/companion`. Signing depends on the available build identity.

The installers offered on murshid.one bundle WebBrain Companion 0.1.2 from the
`systray-v0.1.2` release: the x64 `WebBrainCompanion.exe` from its Windows
setup (it holds an x64 and an Arm64 build) and the binary from its
`linux-x64` archive. They are built with
`npx electron-builder --win nsis --x64` on Windows and
`npx electron-builder --linux AppImage deb --x64` in WSL (Ubuntu 24.04), and
copied into `web/download/`, which is git-ignored and deployed with the site.
For macOS, put the universal Companion app in both `darwin-x64` and `darwin-arm64`, then run `npx electron-builder --mac dmg --universal --publish never`.

## The artwork

The homepage's pictures are gold halftone prints of public-domain paintings
and photographs: Osman Hamdi Bey's *Islamic Theologian* (1902) in the hero, a
Mevlevi dervish of the Vanmour series (Rijksmuseum) beside "The way", and
details of Osman Hamdi Bey's *Public Scribe* and *The Tortoise Trainer* and of
19th-century photographs of Mevlevi dervishes (Rijksmuseum) on the feature
cards. `scripts/art/sources/` holds the parts of them that are used, with
their sources and licence notes.

`scripts/art/halftone.py` raises the local contrast, pushes the backgrounds
away, and prints each picture as a 45° dot screen whose dots grow with the
light: gold in the mid tones, parchment in the lights. The ink is written as
alpha, so the page's crimson and night grounds show between the dots. To
reprint (needs Python 3 with OpenCV, NumPy and Pillow):

```sh
pip install opencv-python-headless numpy pillow
npm run art:pictures   # writes web/art/halftone/*.webp
```

The app icon is a crimson fez with its black silk tassel on a parchment tile,
drawn by `scripts/art/icon.mjs` so it reads from 1024 px down to 16 px. `npm
run art:icons` rebuilds the icon files, and `npm run art` runs both steps.

The screenshot in `web/art/screenshot/` is a real capture of Murshid on
Windows, at 2x, on a fresh profile with no accounts.

## The homepage

`web/` is a static site (HTML, CSS, a little JS, self-hosted fonts). Preview it
with `npm run web` and open http://localhost:4917/web/. Fonts: Cormorant
Garamond, IBM Plex Sans and Mono, and Aref Ruqaa for the Arabic script, all
under the SIL Open Font License (`web/fonts/LICENSE.txt`).

## Licence

GPL-3.0-or-later, like WebBrain. electron-chrome-extensions is MIT.

Ghostery's adblocker packages (`@ghostery/adblocker`,
`@ghostery/adblocker-electron-preload` and the `@ghostery/*` and `@remusao/*`
packages they use) are MPL-2.0, copyright Ghostery GmbH, and their files stay
under the MPL-2.0: Murshid uses them unmodified from `node_modules`, and the
GPL is one of the MPL's Secondary Licenses, so the two combine. tldts, which
they use, is MIT. The filter lists keep their own licences (see "Ad and
tracker blocking").
