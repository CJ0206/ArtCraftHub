# ArtCraft Hub

A small self-hosted launcher for the ArtCraft web apps (WordCraft, GridCraft, DeckCraft, PdfCraft, DesignCraft, PhotoCraft and any others you add). One container, one page, each app in its own tab.

- **Dark by default**, with a light theme toggle. The layout and text scale with the screen, and it works on phones, tablets and desktops.
- **Tabs stay alive** while you switch between apps, so nothing reloads or loses state.
- **Warns before you close the page** while apps are open, and **reopens your tabs** after a refresh or crash.
- **Updates itself.** The container checks each app's latest GitHub release every few hours and installs new versions without a restart. Visitors see a banner offering to refresh.
- **Manage panel** to add, edit, remove and update apps, and to choose a colour for each group. It needs your admin token.
- **Help button** with a plain-language guide to using the apps, adding an app, and the limitations.
- **No uploads.** The server has no endpoint that accepts files. Opening and saving happen in the visitor's browser.
- **amd64, arm64 and armv7**, so it runs on a Raspberry Pi and on normal PCs.

## Deploy

You need a long random admin token. Generate one with `openssl rand -hex 24`.

### Option 1: Portainer app template (easiest)

`templates.json` in this repository is a Portainer v2 app template. Add its entry to your template list (see [Pi-Hosted](#pi-hosted-and-portainer-app-templates) below), then open **App Templates → ArtCraft Hub**, fill in `ADMIN_TOKEN` and deploy.

The container fixes its own folder permissions on start, so no `chown` or user settings are needed, whether `/data` is a bind-mounted folder or a Docker volume.

### Option 2: Portainer stack

*Stacks → Add stack → Web editor*, paste `docker-compose.yml`, add `ADMIN_TOKEN` under *Environment variables*, and deploy. The data lives in a Docker volume named `artcraft-data`, which survives updates.

### Option 3: build it yourself on GitHub

Fork or copy this repository. The workflow in `.github/workflows/docker.yml` builds a multi-architecture image to `ghcr.io/<you>/<repository>:latest` on every push to `main` and weekly. Set the package to **Public** (profile → Packages → your package → Package settings → Change visibility) so other people's Portainer can pull it.

After the first start, open `http://<server>:8086/`, press **Manage**, and watch the apps install.

### HTTPS is required for public use

Browsers only offer the file picker, clipboard access and persistent storage on secure pages (HTTPS, or `localhost`). Over plain `http://192.168.x.x` the apps load but may not be able to save to the visitor's device. Put the container behind HTTPS with a Cloudflare Tunnel, Caddy, Nginx Proxy Manager or Traefik, forwarding to the container's port 8080.

## Pi-Hosted and Portainer app templates

[Pi-Hosted](https://github.com/pi-hosted/pi-hosted) is a popular collection of Portainer app templates and tutorials for hosting self-hosted apps on a Raspberry Pi. Its templates use the same Portainer v2 format as `templates.json` here, so ArtCraft Hub drops straight in.

Portainer reads **one** template list at a time (*Settings → App templates → URL*), so pick one of these:

1. **Add ArtCraft Hub to your own template list.** Copy the object inside `"templates": [ ... ]` in this repository's `templates.json` into your own template file, for example your fork of Pi-Hosted, and point Portainer's *App templates* URL at that file's raw link. This keeps all your other apps.
2. **Use this repository's list on its own.** Set *App templates → URL* to the raw link of `templates.json`:
   `https://raw.githubusercontent.com/CJ0206/ArtCraftHub/main/templates.json`
   This replaces the list, so you will only see ArtCraft Hub.

Then open **App Templates**, choose **ArtCraft Hub**, set the admin token, and deploy.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | none | Enables the Manage panel. Without it the panel is off and the app list is read-only. |
| `UPDATE_INTERVAL_HOURS` | `6` | How often to check GitHub. `0` turns automatic checks off. |
| `GITHUB_TOKEN` | none | Optional. Raises GitHub's 60 requests per hour limit. |
| `KEEP_VERSIONS` | `2` | Installed versions kept per app. |
| `MAX_ZIP_MB` | `400` | Refuse release files bigger than this. |
| `CROSS_ORIGIN_ISOLATION` | off | Set to `1` to send COOP/COEP headers, only if an app needs multi-threaded WebAssembly. |

Everything lives in the `/data` volume: `apps.json` (your list), `categories.json` (group colours), `state.json` (versions and errors), `defaults-seen.json` and `apps/` (the downloaded sites). Delete the volume to start over.

## Changing the default apps and groups

The apps every new install starts with are listed in **`default-apps.json`**. Edit it in your repository and commit; the next image build carries the change.

```json
{ "id": "photocraft", "name": "PhotoCraft", "repo": "storytold/photocraft", "category": "Create", "description": "Photo editing." }
```

- `category` is the group heading on the home page. Use any name; apps with the same name share a group.
- **New installs** get the whole list.
- **Existing installs** get any *new* app you add to the list the next time the container starts. An app the owner removed stays removed. Changes to an app that is already installed (its group, name or description) are not pushed, because the owner may have customised them. They use Manage → Edit instead.
- Group **colours** are chosen in Manage → Group colours, per install.

## Adding an app

In **Manage**, enter a GitHub repository such as `storytold/photocraft`. The hub looks at the repository's latest release and installs the first file whose name matches `-web-.*\.zip$`, which is how the ArtCraft apps name their static web builds. If a repository names its web zip differently, or has none, the card shows which files the release does contain, and you can set your own pattern with **Edit**. The in-app **Help** button explains this to your visitors and lists the limitations.

## Icons and fonts

- The header logo is `public/logo-96.png`. The browser-tab and home-screen icons are `public/icon-32.png`, `icon-192.png`, `icon-512.png` and `apple-touch-icon.png`. To change the logo, replace those files with your own images of the same names and sizes.
- The page uses the best modern font on each device. To use [Inter](https://rsms.me/inter/) everywhere, download it, put the variable font file `InterVariable.woff2` in `public/_hub/fonts/`, and remove the comment markers around the `@font-face` block at the top of `public/_hub/app.css`.

## Things to know

- **Apps share one origin.** Each app runs in an iframe at `/apps/<name>/` on the same domain. That keeps the file picker working and lets tabs share the page, but all apps then share the browser's localStorage and IndexedDB for your domain. If two apps use the same storage key they could overwrite each other. If you see that, the fix is to serve each app on its own subdomain.
- **Treat releases as trusted code.** Because of the shared origin, an app can in principle see the dashboard's storage. Only add repositories you trust. The admin token is kept in memory only and is never written to browser storage.
- **Crash recovery has limits.** The hub remembers which tabs were open. What is inside each document is up to the app: it survives a crash only if that app autosaves to browser storage. Saving to a file on the device is the only guarantee.
- **The "unsaved changes" warning is generic.** Browsers do not let a page see what is unsaved inside an app, so the warning appears whenever any app tab is open. It cannot fire if the browser itself crashes.
- **Memory.** Every open tab is a running WebAssembly app in the visitor's browser. Tabs restored after a refresh load only when clicked.
