# Self-hosting Tailnet Agents

Run Tailnet Agents as the user whose Codex account, SSH configuration, and device access
it should use. Build on the target architecture using the steps in the
[README](../README.md#install). `scripts/start.sh` loads the repository's `.env`.

Existing installations keep the `HUB_*` environment variables, `hub-server`
binary, and tmux/storage names from the original Hub name. The Tailnet Agents
rename does not require moving data or changing a running service's paths.

## Private HTTPS with Tailscale

Keep the backend on loopback and let Tailscale Serve handle HTTPS. Replace the
example hostname with this server's HTTPS name from your tailnet:

```dotenv
HUB_BIND=127.0.0.1
HUB_PORT=4318
HUB_PUBLIC_ORIGIN=https://your-server.your-tailnet.ts.net
```

Enable HTTPS in the tailnet if needed, start Tailnet Agents, then configure Serve:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4318
```

Open that HTTPS address from a device connected to Tailscale. Serve's background
configuration persists independently of Tailnet Agents. Keep Funnel disabled for this
private workspace; tailnet access rules determine which devices can reach it.
To remove this listener, run `tailscale serve --https=443 off`.

You can also use another reverse proxy. Preserve the original Host header,
forward WebSocket upgrades, and set `HUB_PUBLIC_ORIGIN` to the exact browser
origin. Restart Tailnet Agents after changing its environment.

## Authentication and hostnames

Set `HUB_TOKEN` in `.env` to a random value of at least 32 characters to require
an application login. The browser receives an HttpOnly cookie; HTTPS origins
also set the Secure flag. Keep the token out of URLs and source control.

A loopback backend behind private Tailscale Serve can rely on tailnet access
without a Tailnet Agents token. In that configuration, anyone permitted to reach this
service can use the workspace. Binding the backend beyond loopback requires a
token. Tailnet Agents is a single-user workspace with access to its host and SSH devices.

Tailnet Agents validates Host and Origin headers. `HUB_PUBLIC_ORIGIN` adds the public host
to the allowlist; `HUB_ALLOWED_HOSTS` adds exact comma-separated hostname:port
pairs. Wildcards are not supported. See [.env.example](../.env.example).

## Short HTTP addresses

To use an address such as `http://your-server:4318`, keep Tailnet Agents on loopback and add
a private HTTP listener:

```sh
tailscale serve --bg --http=4318 http://127.0.0.1:4318
```

Add the short and full hostname, with `:4318`, to `HUB_ALLOWED_HOSTS`. Use the
hostname instead of a raw IP because Serve routes requests by hostname. Remove
this listener with `tailscale serve --http=4318 off`.

Terminals and the animated Canvas 2D graphics work over HTTP. Remote WebGPU and
PWA installation require HTTPS. WebGPU runs in the viewing device's browser;
it does not render on the Tailnet Agents server. If token login is enabled with an HTTPS
`HUB_PUBLIC_ORIGIN`, use HTTPS: its Secure login cookie is not sent over HTTP.

## SSH devices

Tailscale discovery runs at startup and every 30 seconds. It reads the local
network map and SSH host-key advertisements, and checks port 22 greetings for
other online peers. It does not authenticate or execute remote commands during
discovery. Offline or inaccessible devices are hidden by default in the UI.

Automatic connections use the MagicDNS short name so SSH applies the same
configuration and known-host entry as a normal connection from the Tailnet Agents host.
Custom `user@host` targets and SSH aliases remain unchanged. Connections use
batch authentication and enforce host-key verification.

Establish a trusted SSH connection as the Tailnet Agents service user, and install tmux on
each shell host. Tailscale reachability alone does not grant SSH access. No
Tailnet Agents-specific daemon is required on remote devices. Device connection settings
can save a custom login and test it.

Set `HUB_DISCOVERY=off` to disable discovery, or `HUB_TAILSCALE_BIN` to select a
particular Tailscale CLI executable.

## Semantic memory

Set `OPENROUTER_API_KEY` in the ignored `.env` and restart Tailnet Agents. The Rust backend
uses `qwen/qwen3-embedding-8b` for indexing and query embeddings, at 384 dimensions.
Indexed conversation/tool/terminal text and search queries are sent to
OpenRouter. Its API usage is separate from the Codex account used by the agent.
The key remains server-side; never place it in a `VITE_*` variable.

Upgrading from MiniLM creates a compact backup named
`history.vg.pre-embedding-<id>.vg` beside the database. Model identity is changed
atomically with clearing the old vectors; original events, IDs, and graph links
are preserved. Reindexing then resumes in the background, including after a
restart. The footer shows **Memory indexing** until it catches up. Exact text
search remains available throughout. Retain the backup until you are satisfied
with the migration.

Without a key, or when the provider is unavailable, Tailnet Agents offers text search and
the graph. Hybrid search explicitly indicates its text fallback. Set the key
and restart to resume indexing. Query embeddings are cached and have a bounded
wait so background work cannot hold up the interface. Text matches appear
first; the UI refreshes automatically when Qwen's matches arrive.

`HUB_EMBEDDING_URL` optionally selects a compatible endpoint; the default is
OpenRouter's `/api/v1/embeddings`. HTTPS is required except for loopback test
servers. Changing this endpoint changes the recorded embedding profile and
triggers reindexing, so vectors from different providers are not mixed.

## Mobile installation

Use the HTTPS address, then select **Install Tailnet Agents** in the sidebar. Android
Chrome also offers **Add to Home Screen → Install** in its menu. On iPhone or
iPad, use **Share → Add to Home Screen**. The app launches in a standalone window
with Tailnet Agents’ pixel icon and mobile navigation.

`HUB_PUBLIC_ORIGIN` supplies the secure install link for HTTP visitors. The
service worker caches only the offline connection screen. It does not cache
API responses, terminal history, images, or frontend builds. Live work needs
Tailscale connectivity and an awake Tailnet Agents host.

## Run as a service

An example systemd user unit is in [tailnet-agents.service](tailnet-agents.service). Replace its paths
and ensure its PATH can find Codex and tmux. Run it under the intended user;
enable user lingering if it should continue after logout.

On macOS, a user LaunchAgent can run `scripts/start.sh` from the checkout. Give
it the same working directory and executable PATH as a working shell setup.
A user service requires the Mac to be awake and the user signed in.

Build updates with `npm run build`, then restart the Tailnet Agents service when no agent
turn is running. tmux shells survive a Tailnet Agents restart; an in-flight coordinator
turn does not.

## Data and backups

The default private directory is `data/`; set `HUB_DATA_DIR` to move it. Back up
the **whole directory with Tailnet Agents stopped**, including `history.vg` and
`artifacts/`. It contains conversations, command output, device details,
images, memory vectors, and the coordinator's workspace.

Shell hosts also retain `~/.local/state/hub/terminals/<session-id>.log` for
reconnection and catch-up. These logs may contain anything printed in a
terminal. Automatic retention, spool rotation, and encryption at rest are not
implemented. Do not truncate a live spool file; recorded offsets refer to its
existing bytes. See [persistence](architecture.md#persistence).

`.env`, its local variants, runtime data, database files, logs, and common key
files are excluded from Git. Keep exports and copies of private artifacts out
of source directories too; an arbitrary screenshot or text export is not
recognizable as private by its filename alone.
