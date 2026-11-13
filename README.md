# ArtCraft Hub

A small self-hosted launcher for the ArtCraft web apps (WordCraft, GridCraft, DeckCraft, PdfCraft, DesignCraft, PhotoCraft and any others you add). One container, one page, each app in its own tab.

<p align="center"><img src="docs/screenshots/home-dark.png" alt="ArtCraft Hub home page in the dark theme" width="900"></p>

- **Dark by default**, in a near-black palette with filled grey cards and one blue accent to sit alongside the ArtCraft apps, with a matching light theme toggle. The layout and text scale with the screen, and the header uses compact icon buttons (Help, theme, Settings).
- **Works on phones and tablets.** Home is a single clear column on a phone. Apps get a larger virtual window scaled to fit the screen, with zoom (+ and −), a fit button, and a Move view mode for looking around when zoomed in. Switch it off under Settings → Preferences if you prefer apps at their normal size.
- **Tabs stay alive** while you switch between apps, so nothing reloads or loses state.
- **Several tabs of one app.** Clicking an app on Home always opens a new tab, so the same app can be open more than once (WordCraft, WordCraft 2, …). The **+** in the title bar and Shift-click on a rail icon do the same.
- **Launcher rail.** While an app is open, a scrollable column of app icons on the left switches between apps. It can be hidden, and on phones it becomes a drawer opened from the top-left button. Tabs show whether each app is showing or running in the background, and the open app sits in a framed window with a title bar (icon, name, version, new tab, close).
- **Home grid fits the screen.** Groups share the same columns, as many as fit (4, 5 or more on wide screens, limited by the biggest group), and the whole block stays centred.
- **Warns before you close the page** while apps are open, and **reopens your tabs** after a refresh or crash.
- **Updates itself.** The container checks each app's GitHub releases every few hours and installs new versions without a restart. Visitors see a banner offering to refresh.
- **Progress you can hide.** While an app installs or updates, a card at the bottom-left shows what is happening with a moving progress bar. Hide it and carry on working; it comes back to say the app is ready, or why it could not be installed.
- **Checks what it installs.** Every download is verified before use. Misplaced files are moved into place, and if the newest release is broken the hub keeps or installs the newest one that works and tells you why in Settings.
- **Settings screen**, opened as its own tab from the gear in the header or at the bottom of the rail. **Preferences** (theme, close warning, reopening tabs, small screens) are for every visitor, and **Admin sign-in** unlocks pages to add, edit, remove and update apps, switch automatic updates on or off per app, pin an app to a version, rename groups, choose group colours, and set an optional contact line for the home page footer. The admin pages need your admin token.
- **Explains failures.** If an app cannot start, a bar above it says why. The Help button covers using the apps, fixing problems, adding apps and the limitations.
- **No uploads.** The server has no endpoint that accepts files. Opening and saving happen in the visitor's browser.
- **amd64, arm64 and armv7**, so it runs on a Raspberry Pi and on normal PCs.

## Deploy

You need a long random admin token. Generate one with `openssl rand -hex 24`.

### Portainer stack

*Stacks → Add stack → Web editor*, paste `docker-compose.yml`, add `ADMIN_TOKEN` under *Environment variables*, and deploy. The data lives in a Docker volume named `artcraft-data`, which survives updates.

### Build it yourself on GitHub

Fork or copy this repository. The workflow in `.github/workflows/docker.yml` builds a multi-architecture image to `ghcr.io/<you>/<repository>:latest` on every push to `main` and weekly. Set the package to **Public** (profile → Packages → your package → Package settings → Change visibility) so other people's Portainer can pull it.

After the first start, open `http://<server>:8086/`, open **Settings** (the gear), choose **Admin sign-in**, and watch the apps install.

### HTTPS is required for public use

Browsers only offer the file picker, clipboard access and persistent storage on secure pages (HTTPS, or `localhost`). Over plain `http://192.168.x.x` the apps load but may not be able to save to the visitor's device. Put the container behind HTTPS with a Cloudflare Tunnel, Caddy, Nginx Proxy Manager or Traefik, forwarding to the container's port 8080.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | none | Enables admin sign-in under Settings. Without it the admin pages are off and the app list is read-only. |
| `UPDATE_INTERVAL_HOURS` | `6` | How often to check GitHub. `0` turns automatic checks off. |
| `GITHUB_TOKEN` | none | Optional. Raises GitHub's 60 requests per hour limit. |
| `KEEP_VERSIONS` | `2` | Installed versions kept per app. |
| `MAX_ZIP_MB` | `400` | Refuse release files bigger than this. |
| `QUIET_APPS` | on | Hides routine log, info and debug messages from apps so the browser console shows warnings and errors only. Set to `0` to see everything. |
| `CROSS_ORIGIN_ISOLATION` | off | Set to `1` to send COOP/COEP headers, only if an app needs multi-threaded WebAssembly. |

Everything lives in the `/data` volume: `apps.json` (your list), `categories.json` (group colours), `state.json` (versions, errors and known-broken releases), `settings.json` (footer contact), `defaults-seen.json` and `apps/` (the downloaded sites). Delete the volume to start over.

## Changing the default apps and groups

The apps every new install starts with are listed in **`default-apps.json`**. Edit it in your repository and commit; the next image build carries the change.

```json
{ "id": "photocraft", "name": "PhotoCraft", "repo": "storytold/photocraft", "category": "Create", "description": "Photo editing." }
```

- `category` is the group heading on the home page. Use any name; apps with the same name share a group.
- **New installs** get the whole list.
- **Existing installs** get any *new* app you add to the list the next time the container starts. An app the owner removed stays removed. Changes to an app that is already installed (its group, name or description) are not pushed, because the owner may have customised them. They use Settings → Apps → Edit instead.
- To change an app's description for existing installs too, add the old text to that entry's `oldDescriptions` list, as WordCraft does. Installs that still have the old, unedited text pick up the new one, and descriptions an owner has changed are left alone.
- Group **colours** are chosen in Settings → Groups, per install. Colours are only kept for groups that still have apps.

## Adding and updating apps

In **Settings → Add or edit an app** (after signing in as admin), enter a GitHub repository such as `storytold/photocraft`, optionally with a group, description, release file pattern and icon address. The Group box suggests only the groups that exist now, and you can type a new one.

**How the hub finds and checks the web build**

1. It reads the repository's releases and looks for the web build in each: the usual `*-web-*.zip` name, then any web-looking zip that is not a Windows, macOS or Linux installer. A release file pattern you set takes priority.
2. It downloads the newest one and checks it: there must be an `index.html`, and every file the page's scripts import must be present. Files in the wrong folder are moved into place, and links that point outside the zip are removed.
3. If the newest release fails the check, the next newest is tried (up to four). The broken release is remembered, so it is not downloaded again, and Settings shows the reason. If every release is broken the app is not installed and Settings shows why.

**Updates and versions** (per app, in Settings → Apps)

- **Update automatically** (on by default). When off, the app stays on its installed version. Settings and the home page show an "update available" chip, and you press **Update to …** when ready.
- **Pin this version** holds an app on the version chosen in its list, even an older one, until you unpin it. Pinned apps never change on their own, but still show when something newer exists.
- **Check now** looks for a newer release immediately.

**Progress notices.** Adding, updating, pinning or checking an app starts a card at the bottom-left of the page: *Installing / Updating / Checking*, with what it is doing now (looking for a release, downloading, unpacking and checking). Press the cross to hide it; the work carries on, and the card returns when it finishes with **Open** (new install), **Refresh** (update to an app you have open), or the reason and an **Open Settings** button if it failed. Visitors see the same card while an update downloads, so they know a refresh is coming.

**Icons** are taken, in order, from: an icon address you set, the app's own page (apple-touch-icon or manifest), well-known paths in the repository, the first logo image in the README, then a scored search of the repository's image files. If none is found a lettered tile is shown, and you can set an icon address with **Edit**.

**Groups.** Rename a group in Settings → Groups to move every app in it, and pick its colour. **Home page footer** is off by default; when switched on it shows your email or web address at the bottom of the home page.

If something fails, the in-app **Help** button lists what visitors can try, and the app card in Settings → Apps shows the reason. The red bar above a failed app appears only when a file the app cannot run without (a script, WebAssembly or one of its parts) is missing. Optional files that apps ask for and can live without, such as extra fonts or manifests, are ignored.

## Icons and fonts

- The header logo is `public/logo-96.png`. The browser-tab and home-screen icons are `public/icon-32.png`, `icon-192.png`, `icon-512.png` and `apple-touch-icon.png`. To change the logo, replace those files with your own images of the same names and sizes.
- The page uses the best modern font on each device. To use [Inter](https://rsms.me/inter/) everywhere, download it, put the variable font file `InterVariable.woff2` in `public/_hub/fonts/`, and remove the comment markers around the `@font-face` block at the top of `public/_hub/app.css`.

## Things to know

- **Apps share one origin.** Each app runs in an iframe at `/apps/<name>/` on the same domain. That keeps the file picker working and lets tabs share the page, but all apps then share the browser's localStorage and IndexedDB for your domain. If two apps use the same storage key they could overwrite each other. If you see that, the fix is to serve each app on its own subdomain.
- **Several tabs of one app share that app's saved data.** Save to files, and take care with apps that keep a library in the browser.
- **Treat releases as trusted code.** Because of the shared origin, an app can in principle see the dashboard's storage. Only add repositories you trust. The admin token is kept in memory only and is never written to browser storage.
- **Crash recovery has limits.** The hub remembers which tabs were open. What is inside each document is up to the app: it survives a crash only if that app autosaves to browser storage. Saving to a file on the device is the only guarantee.
- **Close warnings depend on the browser.** Browsers show the warning only after you have clicked or typed on the page, most phone browsers never show it, and none can warn on a crash or shutdown. Settings → Preferences says whether it is active. Background-tab sleeping (Chrome's Memory Saver, Edge's sleeping tabs) can unload apps silently, so add the site to the always-active list.
- **The "unsaved changes" warning is generic.** Browsers do not let a page see what is unsaved inside an app, so the warning appears whenever any app tab is open. It cannot fire if the browser itself crashes.
- **Memory.** Every open tab is a running WebAssembly app in the visitor's browser. Tabs restored after a refresh load only when clicked.

## Screenshots

The app windows in these screenshots are placeholders, so the hub's own interface is the focus.

### Dark and light

Each pair shows the dark theme above the light theme.

<img src="docs/screenshots/compare-home.png" alt="Home page, dark above and light below" width="900">

<img src="docs/screenshots/compare-app.png" alt="An app open with the launcher rail, dark above and light below" width="900">

<img src="docs/screenshots/compare-settings.png" alt="The Settings screen, dark above and light below" width="900">

### Home and wide screens

Groups share the same columns, so tiles line up, and the grid uses as many columns as the screen allows.

<img src="docs/screenshots/wide-screen.png" alt="Home page on a wide screen with five columns" width="900">

### Working in an app

The launcher rail on the left switches apps, the tabs show what is showing or running in the background, and the framed window has a title bar with a button to open another tab of the same app.

<img src="docs/screenshots/app-dark.png" alt="An app open in the dark theme" width="900">

<img src="docs/screenshots/multiple-tabs.png" alt="Two tabs of one app and a second app, with a count on the launcher icon" width="900">

### Settings

Settings opens as its own tab, from the gear in the header or at the bottom of the rail. **Preferences** are for every visitor; the admin pages appear after **Admin sign-in**.

<img src="docs/screenshots/settings-with-app.png" alt="The Settings tab beside an open app, showing Preferences" width="900">

<img src="docs/screenshots/settings-signin-dark.png" alt="Admin sign-in page" width="900">

<img src="docs/screenshots/settings-apps-dark.png" alt="The Apps admin page with an available update and a pinned app" width="900">

<img src="docs/screenshots/settings-edit-dark.png" alt="The Add or edit an app page" width="900">

<img src="docs/screenshots/settings-groups-dark.png" alt="The Groups page: rename groups and choose colours" width="900">

<img src="docs/screenshots/settings-footer-dark.png" alt="The Home page footer page" width="900">

### Help

<img src="docs/screenshots/help.png" alt="The Help and information panel" width="760">

### Phones and tablets

<img src="docs/screenshots/tablet.png" alt="An app on a tablet with zoom controls" width="420">

<img src="docs/screenshots/mobile.png" alt="Phone: home, an app with the launcher collapsed, and the launcher drawer open" width="900">

<img src="docs/screenshots/mobile-settings.png" alt="Phone: Settings with the sections as a strip, and the admin Apps page" width="620">

### Install and update notices

<img src="docs/screenshots/install-notices.png" alt="The progress card while installing, when ready, and if it fails" width="420">

<img src="docs/screenshots/notice-in-context.png" alt="The ready notice at the bottom-left over an open app" width="900">
