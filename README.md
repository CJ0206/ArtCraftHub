# ArtCraft Hub

A small self-hosted launcher for the ArtCraft web apps (WordCraft, GridCraft, DeckCraft, PdfCraft, DesignCraft and any others you add). One container, one page, each app in its own tab.

- **Dark by default**, with a light theme toggle.
- **Tabs stay alive** while you switch between apps, so nothing reloads or loses state.
- **Warns before you close the page** while apps are open, and **reopens your tabs** after a refresh or crash.
- **Updates itself.** The container checks each app's latest GitHub release every few hours and swaps in the new version without a restart. Old versions are pruned.
- **Admin panel** (Manage button) to add, edit, remove and update apps. Visitors can see the button, but nothing in it works without your token.
- **No uploads.** The server has no endpoint that accepts files. Opening and saving happen in the visitor's browser.
- **amd64, arm64 and armv7** (Raspberry Pi and regular PCs). The container is only Node plus static files.

## Deploy with Portainer

You need a long random admin token. Generate one with `openssl rand -hex 24`.

**Option A: build on the device (simplest).** Push this folder to a Git repository, then in Portainer go to *Stacks → Add stack → Repository*, point it at the repo, set the compose path to `docker-compose.yml`, and in the compose file replace the `image:` line with `build: .`. Add `ADMIN_TOKEN` under environment variables and deploy.

**Option B: pull a prebuilt image.** Push this folder to GitHub. The included workflow builds a multi-architecture image to `ghcr.io/<you>/artcraft-hub:latest` on every push and weekly. Make the package public (or add registry credentials in Portainer), put your username in `docker-compose.yml`, and deploy it as a web-editor stack.

The first start downloads the default apps in the background. Open `http://<server>:8086/`, press **Manage**, and watch them install.

### HTTPS is required for public use

Browsers only offer the file picker, clipboard access and persistent storage on secure pages (HTTPS, or `localhost`). Over plain `http://192.168.x.x` the apps will load but may not be able to save to the visitor's device. Put the container behind HTTPS with a Cloudflare Tunnel, Caddy, Nginx Proxy Manager or Traefik, forwarding to port 8080.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | none | Enables the Manage panel. Without it the panel is off and the app list is read-only. |
| `UPDATE_INTERVAL_HOURS` | `6` | How often to check GitHub. `0` turns automatic checks off. |
| `GITHUB_TOKEN` | none | Optional. Raises GitHub's 60 requests per hour limit. |
| `KEEP_VERSIONS` | `2` | Installed versions kept per app. |
| `MAX_ZIP_MB` | `400` | Refuse release files bigger than this. |
| `CROSS_ORIGIN_ISOLATION` | off | Set to `1` to send COOP/COEP headers, only if an app needs multi-threaded WebAssembly. |

Everything lives in the `/data` volume: `apps.json` (your list), `state.json` (versions and errors) and `apps/` (the downloaded sites). Delete the volume to start over.

## Adding an app

In **Manage**, enter a GitHub repository such as `storytold/photocraft`. The hub looks at the repository's latest release and installs the first file whose name matches `-web-.*\.zip$`, which is how the ArtCraft apps name their static web builds. If a repository names its web zip differently, or has none, the card shows what files the release does contain, and you can set your own pattern with **Edit**.

## Things to know

- **Apps share one origin.** Each app runs in an iframe at `/apps/<name>/` on the same domain. That keeps the file picker working and lets tabs share the page, but it also means all apps share the browser's localStorage and IndexedDB for your domain. If two apps happen to use the same storage key, they could overwrite each other's saved state. If you see that, the fix is to serve each app on its own subdomain.
- **Treat releases as trusted code.** Because of the shared origin, an app can in principle see the dashboard's storage. You are choosing to run each upstream project's code, so only add repositories you trust. The admin token is kept in memory only and is never written to browser storage.
- **Crash recovery has limits.** The hub remembers which tabs were open. What is inside each document is up to the app: it survives a crash only if that app autosaves to browser storage. Saving to a file on the device is the only guarantee.
- **The "unsaved changes" warning is generic.** Browsers do not let a page see what is unsaved inside an app, so the warning appears whenever any app tab is open. It cannot fire if the browser itself crashes.
- **Memory.** Every open tab is a running WebAssembly app in the visitor's browser. Tabs restored after a refresh load only when clicked.
