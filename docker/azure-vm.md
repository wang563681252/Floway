# Azure VM Deployment

## Scope

Deploy the current Floway source to an existing Linux VM over SSH. Reuse the
Node server, Nginx dashboard, and SQLite/files volume from
[docker-compose.yml](docker-compose.yml). No new Azure managed services are
required. This preparation does not provision resources, change Cloudflare,
export credentials, or switch clients.

The VM configuration is the base Compose file plus
[azure-vm.compose.yml](azure-vm.compose.yml). It adds release-specific image
tags, bounded container logs, the `AZURE` runtime location, and loopback-only
host ports. Its `!override` port replacement requires Docker Compose 2.24.4+
([Compose merge rules](https://docs.docker.com/reference/compose-file/merge/#replace-value)).

## Server Details Needed

- SSH host or IP, port, username, and the local private-key file path or SSH
  config host alias. Do not send private-key contents or passwords in chat.
- SSH host-key fingerprint obtained through a trusted channel; do not disable
  host-key verification.
- Distribution/version, CPU architecture, RAM, available disk, and whether
  the SSH user can administer Docker and use sudo.
- Existing services and listeners on ports 80/443, the desired domain, and
  whether an HTTPS reverse proxy already exists.
- Whether this is a new instance or a replacement for the Cloudflare instance,
  the data to retain, and an acceptable cutover window.

Use Ubuntu/Debian on amd64 or arm64 as the initial assumption until the VM is
identified. Start capacity planning around 2 vCPU and 4 GB RAM; building images
may need more memory, so measure before choosing the final VM size. The existing
Dockerfile supplies Node 22.23.1 and pnpm; host Node is not required.

Keep Docker's data directory on a persistent managed disk, not Azure temporary
storage such as `/mnt/resource` or an ephemeral OS disk. Use a single server
replica with its local SQLite volume; this setup is not a multi-VM database.
VM, managed disk, IP and bandwidth charges remain even though the Node target
does not use D1, KV, R2, Images or Durable Objects. An existing VM may be cheaper
than a new dedicated one; do not provision one solely on that assumption.

## Prepare The Release

Use `/opt/floway/releases/<release>` for source and `/opt/floway/shared/.env`
for the server's environment file. Restrict the latter to the deployment user
with mode `0600`, in a directory with mode `0700`.

Start from [azure-vm.env.example](azure-vm.env.example). Set a fresh, random
`ADMIN_KEY` directly on the host or through a secure secret channel, and set
`FLOWAY_RELEASE` to a unique tag for this source snapshot. Never store the real
environment file in source control or a release archive. Avoid printing the
resolved Compose environment because it contains the administrator secret.

Build from the current working-tree contents, including the uncommitted GPT-6
pricing and tool fixes. A plain clone or `git archive HEAD` would omit these.
Assemble transfer archives from an explicit source inventory, including these
deployment files. Exclude `.git`, credentials, `wrangler.jsonc`, `.wrangler`,
environment files, `node_modules`, local databases, backups, personal files,
and unrelated untracked debug scripts. Verify an archive SHA-256 before and
after transfer. Do not upload the workspace directory indiscriminately.

From the extracted release directory, use this Bash helper for all operations:

```bash
compose() {
  docker compose --project-name floway \
    --env-file /opt/floway/shared/.env \
    -f docker/docker-compose.yml \
    -f docker/azure-vm.compose.yml "$@"
}

compose config --quiet
compose build --pull
compose up -d --no-build --wait --wait-timeout 180
compose ps
curl --fail --show-error http://127.0.0.1:8788/api/health
curl --fail --show-error http://127.0.0.1:18088/api/health
curl --fail --show-error --output /dev/null http://127.0.0.1:18088/
```

The server applies migrations on startup. The stable project name keeps the
data volume at `floway_floway-data` across release directories. Never use
`docker compose down -v` or prune this volume. Containers restart automatically,
but the host must also start Docker after reboot.

## Private Acceptance And HTTPS

Before exposing the service, open an SSH tunnel from the workstation:

```bash
ssh -N -L 18088:127.0.0.1:18088 -p <ssh-port> <ssh-user>@<ssh-host>
```

Visit `http://localhost:18088`. Choose another local tunnel port if it is busy.
Both gateway and dashboard ports remain bound to `127.0.0.1` on the VM.

### Public HTTP By IP

HTTP does not require a domain. It is an explicit alternative to HTTPS, not the
default: passwords, session tokens, API keys, content, and downloaded installer
scripts are not protected against interception or modification in transit.

To enable HTTP after accepting that tradeoff, add
[azure-vm.http.compose.yml](azure-vm.http.compose.yml). It publishes host TCP 80
through the existing Nginx service and retains both loopback ports. It does not
restart the server or change the data volume:

```bash
compose_http() {
  docker compose --project-name floway \
    --env-file /opt/floway/shared/.env \
    -f docker/docker-compose.yml \
    -f docker/azure-vm.compose.yml \
    -f docker/azure-vm.http.compose.yml "$@"
}

compose_http config --quiet
compose_http up -d --no-build --no-deps --wait --wait-timeout 180 web
```

Open `http://<VM-public-IP>` after allowing inbound TCP 80 for this VM. Open
Agent Setup from that origin to generate a public `SETUP_ENDPOINT`; a command
generated through the SSH tunnel retains its workstation-only loopback address.
Verify the external homepage and health endpoint, and that protected APIs still
reject unauthenticated requests. Do not expose 8788 or 18088 publicly.

Use `compose_http` for subsequent HTTP deployments. To return to private-only
access, run `compose up -d --no-build --no-deps --wait web` with the original
two-file helper. This changes only the web bindings; it does not roll back data.

### Public HTTPS

If the VM already has an HTTPS ingress, keep it and proxy to
`http://127.0.0.1:18088`. Otherwise, use
[azure-vm.https.compose.yml](azure-vm.https.compose.yml) and
[Caddyfile.azure-vm](Caddyfile.azure-vm). Caddy owns public TCP 80/443 and
forwards both the dashboard and API traffic to the existing `web:80` container.
It preserves Host, supports WebSocket upgrades, flushes SSE immediately, and
keeps client cancellation enabled. Nginx retains the internal gateway routing
and long-response settings in [nginx.conf](nginx.conf).

A purchased domain is not required. Set a DNS name label on the VM's Azure
public IP resource and use the exact FQDN shown in the portal, typically
`<label>.<region>.cloudapp.azure.com`
([Azure public IP DNS labels](https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-addresses#domain-name-label)).
Verify that it resolves to this VM before starting Caddy.

Copy [azure-vm.https.env.example](azure-vm.https.env.example) to
`/opt/floway/shared/https.env`, set `FLOWAY_DOMAIN` to that FQDN without a scheme,
port, or path, and restrict the file to mode `0600`. This separate environment
file leaves the existing administrator secret and release settings untouched.

From the active release directory, define:

```bash
compose_https() {
  docker compose --project-name floway \
    --env-file /opt/floway/shared/.env \
    --env-file /opt/floway/shared/https.env \
    -f docker/docker-compose.yml \
    -f docker/azure-vm.compose.yml \
    -f docker/azure-vm.https.compose.yml "$@"
}

compose_https config --quiet
compose_https pull caddy
compose_https run --rm --no-deps --interactive=false -T caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
compose_https up -d --no-build --no-deps --wait --wait-timeout 180 web
compose_https up -d --no-build --no-deps --wait --wait-timeout 180 caddy
compose_https logs --tail 100 caddy
```

Do not include the HTTP overlay in this helper. When switching from public
HTTP, recreating only `web` releases port 80 before Caddy starts; the server
container and `floway_floway-data` volume are unchanged. Expect a brief ingress
interruption. Resolve any unrelated 80/443 listener before this cutover.

Caddy [automatically obtains and renews certificates](https://caddyserver.com/docs/automatic-https).
Its ACME account and certificates persist in `floway_floway-caddy-data`; retain
that volume and `floway_floway-caddy-config` across releases. Do not use
`down -v` or prune these volumes. HTTP requests, including requests to the
public IP, use a method-preserving 308 redirect to the configured HTTPS domain.
Use `compose_https` for subsequent HTTPS deployments so the ingress configuration
remains active.

The container health check verifies that Caddy has loaded its configuration,
not that public DNS, certificates, or the upstream work. Separately verify the
HTTPS homepage and `/api/health` with certificate validation enabled, HTTP
redirects with paths/query strings preserved, unauthenticated API rejection,
dashboard login, SSE streaming and WebSocket use through the final HTTPS
address. Confirm backend ports remain private. Update client base URLs and
regenerate Agent Setup commands from the HTTPS origin only after acceptance.

For an ingress-only rollback, stop Caddy with `compose_https stop caddy`, then
run `compose up -d --no-build --no-deps --wait web` for private access, or
`compose_http up -d --no-build --no-deps --wait web` to restore the explicitly
insecure HTTP option. Keep the certificate volumes; no database restore or
server restart is involved.

Allow SSH only from the operator's IP or through an existing private/Bastion
path. Open 80/443 only for the chosen ingress; do not open 8788/18088 in
the Azure NSG or host firewall. Verify these rules after Docker starts rather
than relying on a host firewall alone. HTTPS is recommended for credential-bearing
traffic; the HTTP option above does not provide transport encryption.

The existing `workers.dev` address cannot be repointed to this VM. Plan a new
base URL or a domain you control, and update clients only after acceptance.

## Data Migration And Cutover

Do not capture a production export during preparation: it contains live API
keys, provider tokens, password hashes, and server secrets, and will become
stale while Cloudflare continues receiving traffic.

At migration time, inventory both stores and take an authoritative final
snapshot after pausing writes. The portable backup has these boundaries:

| Data | Transfer path |
| --- | --- |
| Users, API keys, upstreams, proxies, token/search usage and search settings | Admin `GET /api/export?include_performance=1`, then import into the new instance |
| Performance history | Included only when `include_performance=1` is requested |
| Model aliases | Separate `GET /api/aliases`; recreate through `POST /api/aliases`, preserving names, targets, rules, visibility and sort order |
| Sessions, stored OpenAI Responses state, dump bodies and other stored files | Not included in the portable export; assess a database-plus-files migration if these must survive |
| Image cache | Rebuildable on Node; not a credential or usage backup |

Do not treat the JSON backup as a complete database/file backup. Do not cut over
until the treatment of omitted state is agreed. In particular, existing
`previous_response_id` chains may depend on stored Responses state.

Import only into a new, isolated VM instance. The import endpoint accepts
`{ "mode": "replace", "data": <exported JSON> }`; replace is destructive and
the cross-repository import is not one transaction. Back up a non-empty target
first and do not retry after a partial failure without checking its state.
Never import into Cloudflare as part of this VM migration.

Preserve all current aliases, including `claude-opus-5-1 -> gpt-6-astra` and the
Sol aliases' `serviceTier: "priority"` rules. Preserve the existing transport
policy initially. Changing `direct_connect` to `direct_fetch` is a separate
compatibility/performance test, not an automatic consequence of moving to Node.
Review any Cloudflare-colo-specific routing rules against `RUNTIME_LOCATION`.

Before switching clients, verify:

1. Dashboard login, users, API keys, upstreams, search settings and alias parity.
2. GPT-6 prices and historical usage costs, including unchanged request/token
   counts and the already repaired historical unit prices.
3. Model discovery, a short generation, SSE streaming, WebSocket use where
   applicable, tool calls, images and a long response with client cancellation.
4. Restart persistence and a backup/restore rehearsal on an isolated volume.
5. New requests record costs on the VM, and HTTPS certificates and routing work
   from a real client outside the VM.

Keep Cloudflare intact during acceptance. Pause client traffic for the final
snapshot/import, verify parity, then switch the configured base URLs. Running
both writers indefinitely splits usage history. Capture any Azure-side writes
before a rollback; switching the URL back alone does not merge those records.
Stop Cloudflare billing resources only after a separately confirmed cutover.

## Backup And Rollback

Before upgrades, stop the server and archive the complete data volume, including
SQLite WAL/SHM files and `/data/files`, or use a verified SQLite online-backup
method with a coordinated file backup. Do not copy only a live database file.
Encrypt backups, restrict access, and retain a copy off the VM.

Retain the previous release's source, image tags, environment settings and data
backup. To roll back code, select its `FLOWAY_RELEASE` and run
`compose up -d --no-build --wait`. If migrations changed the schema, restore the
matching data backup while stopped before using older code. Do not restore an
old snapshot over newer production writes without an explicit recovery decision.

## Preparation Checks

Compose validation must confirm exactly one loopback port per service in the
private baseline. The optional HTTP overlay must add only TCP 80 to the web
service, preserving all other configuration. The HTTPS overlay must keep those
backend ports private, publish TCP 80/443 only through Caddy, retain persistent
certificate storage, and reject an empty `FLOWAY_DOMAIN`. Verify data mounts,
server health dependency, bounded logs, unique image tags, and rejection of an
empty `ADMIN_KEY`. Build and run both application images for source deployments;
an ingress-only change reuses the running release's images without rebuilding
or restarting the server. Configuration validation alone is not a container
startup test.

The workstation's Docker CLI can validate this configuration, but its Linux
engine was not running during initial preparation. Image build, runtime health,
SSH, final TLS and migration acceptance remain deployment-time gates.