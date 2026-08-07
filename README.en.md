# Homelab Dashboard

Your whole home server on one screen — and you can act on it right there.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[简体中文](README.md) · **English**

Security alerts, disk capacity, service health, host load, network throughput,
certificate expiry, exposed ports, live connections, Docker containers, drive
SMART — thirteen collectors on a single page. And not just watching: ban an IP,
restart a container, get a disk-full ETA, and receive a push on your phone when
something breaks. It also
[manages multiple machines](#managing-multiple-machines): ban once, enforced
everywhere.

The frontend has no build step and no dependencies. Charts are hand-written SVG.
Three files, that's it.

**Live demo → <https://homelab.88688.team>** (fully simulated data, click anything)

---

## Table of Contents

- [What it's for](#what-its-for)
- [Features](#features)
- [Getting Started](#getting-started)
  - [Live demo](#live-demo)
  - [Prerequisites](#prerequisites)
  - [Step 1: Install CrowdSec (optional but recommended)](#step-1-install-crowdsec-optional-but-recommended)
  - [Step 2: Install the firewall bouncer](#step-2-install-the-firewall-bouncer)
  - [Step 3: Tell CrowdSec which logs to read](#step-3-tell-crowdsec-which-logs-to-read)
  - [Step 4: Deploy the dashboard](#step-4-deploy-the-dashboard)
  - [Step 5: Set up login](#step-5-set-up-login)
- [Configuration](#configuration)
- [Container permissions](#container-permissions)
- [Security notes](#security-notes)
- [Features in detail](#features-in-detail)
- [Deploying to a remote host](#deploying-to-a-remote-host)
- [Managing multiple machines](#managing-multiple-machines)
- [External watchdog](#external-watchdog)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## What it's for

When you run a NAS or a small server at home, its state is scattered across a
dozen places: the NAS web UI for capacity, Portainer for containers, `cscli` for
attacks, SSH plus `df -h` for disks — and nothing at all reminds you that a
certificate expires next week. When something actually goes wrong, you go
digging through all of them.

This dashboard pulls them onto one page, and **lets you act where you found the
problem**: see an IP brute-forcing SSH, hit "ban"; see a container down, restart
it on the spot.

### Why not Grafana

Grafana is great at time series and multiple data sources, weak at
"one-screen card overview", and it can't do one-click IP bans — it's a read-only
observability surface, not a control panel. If you already run Prometheus, the
two coexist happily: Grafana for trend detail, this for "is everything OK right
now".

### Good fit

- One Linux box that's always on (NAS, mini PC, retired laptop)
- Docker installed, a handful of services running
- You want to know if someone is attacking it, and to strike back directly

### Bad fit

- Large-scale clusters — it handles a handful to a dozen machines (see
  [Managing multiple machines](#managing-multiple-machines)); beyond that reach
  for Prometheus and Ansible
- Long-term high-resolution metrics — history is minute-level sampling; use Prometheus
- Multi-user access control — login is single-user, no RBAC, and none is planned

---

## Features

| Tab | What's in it |
|---|---|
| **Overview** | Security posture, managed nodes, storage, host load, network, service health, port exposure, containers, drives, certificates |
| **Firewall** | Ban list (manual / detected / community blocklist), top attack sources, country and ASN breakdown, allowlist, one-click ban and unban |
| **Connections** | Who is connected right now, with GeoIP attribution, human-readable TCP states, grouped by service port |
| **Ports** | Every listening port, graded as public / LAN-reachable / localhost-only |
| **History** | Trend charts, event timeline, operation audit, capacity forecast, sampling health |
| **Containers** | Start/stop/restart, log viewer, protected list, btrfs snapshot cleanup command generation |
| **Settings** | Edit alert rules in the UI, mute individual alerts, push toggle |

Thirteen collectors: `host` `network` `containers` `services` `crowdsec` `storage`
`certs` `remote` `nodes` `ports` `connections` `engine` `disks`. Each runs on its own
loop and fails independently — one broken collector doesn't blank out the rest.

> Want to see it in action: **<https://homelab.88688.team>**. Screenshots of your
> own deployment are welcome in `docs/screenshots/`.

---

## Getting Started

### Live demo

**<https://homelab.88688.team>** — nothing to install, click around freely.

All data on the demo is simulated; none of it comes from a real machine. Actions
like banning an IP or restarting a container really do take effect and show up in
the UI, but they only mutate in-memory state and reset every hour. To run demo
mode on your own machine (say, to show a colleague), use the demo compose file:

```bash
docker compose -f docker-compose.demo.yml up -d --build
```

The demo instance mounts no host paths, runs with `cap_drop: ALL`, and binds only
to loopback — it cannot read anything from its host, which is precisely why it's
safe to expose.

### Prerequisites

**Required**

- **A Linux host** — it reads `/proc`, `/sys` and `/proc/mdstat`; macOS and Windows are not supported
- **Docker** and **docker compose** (v2, i.e. `docker compose`, not `docker-compose`)

**Optional but strongly recommended**

- **[CrowdSec](https://www.crowdsec.net/)** — required for the firewall, bans and
  attack-source features. Without it the dashboard still runs; those cards just
  report "unavailable" and nothing else is affected
- **smartmontools** — needed for drive SMART monitoring (`smartctl`)
- **btrfs-progs** — only if you use btrfs and want snapshot info

If you just want to see what it looks like, skip every optional item and jump to
[Step 4](#step-4-deploy-the-dashboard).

---

### Step 1: Install CrowdSec (optional but recommended)

CrowdSec is an open-source intrusion detection system: it reads your logs
(nginx, sshd, smb…), identifies attacks, and produces "ban decisions". It does
not block anything itself — blocking is the bouncer's job.

**Debian / Ubuntu**

```bash
curl -s https://install.crowdsec.net | sudo sh
sudo apt install crowdsec
```

**RHEL / CentOS / Fedora / Rocky**

```bash
curl -s https://install.crowdsec.net | sudo sh
sudo dnf install crowdsec
```

**Alpine**

```bash
sudo apk add crowdsec
```

**Others**: see the [official install docs](https://docs.crowdsec.net/docs/getting_started/install_crowdsec/).

Verify the service is up:

```bash
sudo systemctl status crowdsec
sudo cscli metrics          # parsing stats means it's working
```

CrowdSec auto-detects the services on your machine and installs matching rule
sets (collections). Check what you got:

```bash
sudo cscli collections list
```

You'd typically see `crowdsecurity/nginx`, `crowdsecurity/sshd`,
`crowdsecurity/linux` and friends. Install anything missing:

```bash
sudo cscli collections install crowdsecurity/nginx
sudo systemctl reload crowdsec
```

---

### Step 2: Install the firewall bouncer

**Don't skip this.** CrowdSec only decides *who* should be banned; the bouncer
is what actually keeps them out. Without it, clicking "ban" in the dashboard
writes the decision successfully — and traffic keeps flowing in.

```bash
# Debian / Ubuntu (iptables)
sudo apt install crowdsec-firewall-bouncer-iptables

# If your system uses nftables
sudo apt install crowdsec-firewall-bouncer-nftables

# RHEL family
sudo dnf install crowdsec-firewall-bouncer-iptables
```

Confirm it registered:

```bash
sudo cscli bouncers list
```

You should see a `cs-firewall-bouncer-xxxxx` with a check mark under `Valid`.

**Bans take effect with a delay.** The bouncer polls the LAPI for decisions
every 10 seconds by default, so there's roughly a 10-second gap between clicking
ban and iptables actually dropping the traffic. That's normal, not a stuck UI.

---

### Step 3: Tell CrowdSec which logs to read

CrowdSec finds attacks by reading logs. No logs, no detections. Configuration
lives in `/etc/crowdsec/acquis.yaml` or `/etc/crowdsec/acquis.d/*.yaml`.

The config generated at install time is usually fine, but **if your services run
in Docker, the log paths often aren't where CrowdSec expects**, so you'll need to
add them. For example, an nginx container writing to a host bind mount:

```yaml
# /etc/crowdsec/acquis.d/my-nginx.yaml
filenames:
  - /var/log/nginx/*.log
  - /opt/nginx/logs/access.log      # your own path
labels:
  type: nginx
```

Reload and check:

```bash
sudo systemctl reload crowdsec
sudo cscli metrics
```

**Look at the parse rate in the "Acquisition Metrics" table.** If a source shows
`Lines parsed: 0` with a large `Lines unparsed`, the `type` label is wrong or the
parser is missing — that source is burning CPU for nothing. The dashboard's
"Detection engine" card flags these zero-yield sources for you.

> Parse rate must be read **per source**. A global parse rate is meaningless:
> most lines in syslog have no matching parser by design, and mixing it in will
> drag a perfectly healthy nginx source down to single digits, making you think
> the whole system is broken.

---

### Step 4: Deploy the dashboard

```bash
git clone https://github.com/mxx1111/Homelab.git
cd Homelab
cp config.example.yaml config.yaml
```

Open `config.yaml` and **change at least these**:

```yaml
site_name: MyNAS              # push notification prefix; distinguishes machines

storage:
  volumes:
    - label: System
      path: /hostfs           # the host root is mounted here inside the container
      warn: 80
      crit: 90
    - label: Data             # add your own mount points
      path: /hostfs/mnt/data
      warn: 80
      crit: 90

services:                     # health probes, issued from the host itself
  - name: My blog
    url: http://127.0.0.1:8080/
    expect: [200, 302]

certs:
  targets:                    # domains to check for expiry; empty list is fine
    - host: example.com
      port: 443
```

Then start it:

```bash
docker compose up -d --build
```

Open `http://<your-server>:8770`.

**Check the logs on first run** to see how each collector fared:

```bash
docker logs -f homelab-dashboard
```

---

### Step 5: Set up login

Out of the box **every write operation is refused** — bans, unbans, container
restarts and alert-rule edits all return 403. The dashboard can modify your
firewall and control your containers.

**Recommended: enable login**

```yaml
# config.yaml
auth:
  enabled: true
  username: admin
  password: "your-password"
```

Once logged in, write operations are allowed without a separate token. Sessions
last 7 days by default; five failed attempts from one IP locks it for 15 minutes.

The password can be plain text, or a hash. Prefer the hash — `config.yaml` tends
to get pasted into issues while troubleshooting, and a hash costs you nothing
when it leaks:

```bash
docker exec homelab-dashboard python -m backend.hashpw 'your-password'
# paste the whole output line into auth.password
```

**With multiple nodes this step is not optional.** Once nodes are attached, one
page can change the firewall on every machine and holds the SSH keys to all of
them — no authentication means your whole fleet hangs off an open web page.

**Also available: an operation token (for scripts)**

```yaml
firewall:
  write_token: "some-random-string"    # openssl rand -hex 24
```

Requests carrying the `X-Panel-Token` header may write without logging in. This
exists for scripting — a one-line curl to ban an IP shouldn't have to negotiate
a session cookie first. The UI also grows a token field, kept in localStorage.

**Fallback: declare the network trusted**

```yaml
firewall:
  allow_anonymous_write: true
```

Only when the dashboard is genuinely reachable from your LAN or VPN only, and
you don't plan to attach nodes.

Restart afterwards:

```bash
docker compose restart
```

---

## Configuration

Configuration lives in `config.yaml`, copied from `config.example.yaml`.
Lookup order: `HOMELAB_CONFIG` env var → `/etc/homelab-dashboard/config.yaml` →
`config.yaml` in the repo root → `config.example.yaml` (fallback, so a fresh
clone starts up).

| Section | Purpose |
|---|---|
| `site_name` | Push notification prefix, also shown in the page header |
| `server` | Listen address and port, default `0.0.0.0:8770` |
| `intervals` | Per-collector interval in seconds; slow ones get longer gaps |
| `storage.volumes` | Volumes to monitor and their thresholds. **The host root is `/hostfs` inside the container** |
| `storage.snapshot_mounts` | Mount points to scan for btrfs snapshots; leave empty if not btrfs |
| `services` | Health probes; `expect` is the list of acceptable HTTP status codes |
| `certs.targets` | Domains and ports to check for expiry |
| `network.interface` | Empty means auto-pick the busiest physical NIC |
| `crowdsec` | LAPI URL, database path, credentials file |
| `firewall` | Write switch and token, see [Step 5](#step-5-set-up-login) |
| `history` | SQLite history path and retention |
| `notify` | Server酱 push; the SendKey comes from the environment, not from here |
| `alerts.rules` | Thresholds and switches — **also editable from the Settings tab** |
| `ports` | Port labels, declared public ports, allowlist script path |
| `disks.warn_hours` | Power-on hours before a drive is flagged, default 35000 (~4 years) |
| `actions` | Container operation switch and protected names |
| `remote_hosts` | Remote hosts to collect from over SSH |

### About the intervals

The defaults are deliberate. Two worth calling out:

- `disks: 1800` — SMART queries **spin up sleeping mechanical drives**. Too short
  an interval keeps them awake forever, wasting power and drive life.
- `storage: 300` — btrfs snapshot scanning walks subvolumes and takes seconds on
  a machine with many snapshots.

### Alert rules

Values under `alerts.rules` are defaults. Changes made in the Settings tab are
stored in SQLite and deep-merged over the config file per field — so changing one
threshold won't reset the others, and no restart is needed. There's a "restore
defaults" button.

Alerts don't fire on the first blip: `sustain_seconds` (default 120) requires the
condition to persist that long, which suppresses false positives from occasional
probe timeouts.

---

## Container permissions

The dashboard reads host data through mounts and two capabilities.
**It does not need `privileged`.** Review each line before deploying — drop the
mounts for features you don't want and the dashboard degrades gracefully.

| Mount / capability | Why | Without it |
|---|---|---|
| `network_mode: host` | Reads `/proc/net/*` for throughput, listening ports, live connections | Network, ports and connections stop working |
| `/:/hostfs:ro` | Host root filesystem capacity | Storage reports the container's own overlay layer |
| `/var/run/docker.sock:ro` | Container list and resource usage | Containers tab is empty |
| `/usr/bin/docker:ro` | Reuses the host docker CLI instead of shipping one | Same as above |
| `/var/lib/crowdsec/data:ro` | Reads alert details from SQLite | Attack sources and alert stats unavailable |
| `/etc/crowdsec/local_api_credentials.yaml:ro` | Bans/unbans require writing to the LAPI | Read-only, can't ban |
| `cap_add: SYS_ADMIN` | The btrfs `subvolume list` ioctl | Snapshot features unavailable |
| `cap_add: SYS_RAWIO` + `/dev:ro` + `device_cgroup_rules` | `smartctl` reading drive SMART | Drive health card unavailable |
| `/sys/class/thermal:ro` | CPU temperature | Temperature blank |
| `./data:/app/data` | **The only writable mount** — the history database | History lost on restart |

Put host-specific mounts in `docker-compose.override.yml` (compose merges it
automatically, and it's already gitignored) so upgrades don't touch the main file:

```yaml
# docker-compose.override.yml
services:
  dashboard:
    volumes:
      - /mnt/data:/mnt/data:ro
```

### How the dashboard can ban IPs

It reuses the CrowdSec agent's own machine credentials
(`/etc/crowdsec/local_api_credentials.yaml`, mounted read-only) to log into the
LAPI, then calls `/v1/decisions` with the resulting JWT.

**Why not write to SQLite directly**: a direct database write never notifies the
bouncer, so the rule never reaches iptables. All writes must go through the LAPI.

---

## Security notes

**This dashboard aggregates the state of an entire machine on one page** —
service inventory, exposed ports, container list, internal topology — which is
exactly the intelligence an attacker wants. Add firewall and container control
on top, and carelessly exposing it to the internet is a disaster.

The tradeoffs it makes:

1. **Writes are refused by default.** With neither login nor `write_token`
   configured, every write endpoint returns 403. Enable login, set a token, or
   explicitly declare `allow_anonymous_write: true`.
2. **Login is single-user.** Username/password, in-memory sessions, failed-attempt
   rate limiting. No RBAC, no multi-user, no password recovery — for a one-person
   setup those are just attack surface you'd have to maintain. Sessions live in
   memory and die with a restart; the cost is logging in again, the benefit is
   never having to persist a session key.
3. **Protected networks can't be banned.** Private ranges (`10/8`, `172.16/12`,
   `192.168/16`), loopback and the Tailscale CGNAT range (`100.64/10`) are
   hard-protected in code so you can't lock yourself out. Extend the list via
   `crowdsec.protected_networks`.
4. **Snapshot deletion only generates a command.** Volumes are mounted read-only;
   the dashboard hands you a command to run on the host yourself. Granting a web
   page the right to delete data isn't worth what it saves.
5. **Only writes are audited.** The UI polls every 5 seconds — logging GETs would
   bury the useful entries under tens of thousands of rows a day. Page visits are
   recorded once per IP per hour.

**Recommended deployment**

- Bind to your LAN only, restrict source ranges with a firewall
- For remote access use Tailscale / WireGuard / ZeroTier — **don't port-forward**
- If you must expose it, enable login *and* put an authenticating reverse proxy
  in front (Authelia, Cloudflare Access, …)
- **Attaching nodes makes login mandatory** — at that point the page can change
  the firewall on every machine and holds SSH keys to all of them

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Features in detail

### Firewall

The ban list is split into three kinds because they behave differently:

- **Manual** — you banned it, you can unban it
- **Detected** — matched a CrowdSec scenario, can be unbanned
- **Community blocklist** — CrowdSec central intelligence, often tens of
  thousands of entries. **Unbanning is undone on the next sync**, because the
  decision isn't local

A community blocklist can hold 15k+ entries, which would overwhelm the frontend.
The strategy: return the first two kinds in full, sample only the most recent
community entries, and **count the total with a separate SQL COUNT** — so the
number you see is accurate even though the list is truncated. Search queries the
database directly and isn't limited this way.

### Allowlist

CrowdSec's native whitelist is a parser-level YAML config that requires a service
reload. The dashboard runs in a container: it has neither write access to the
config directory nor any business restarting a systemd service on the host.

So this is implemented as a watchdog instead: after each collection cycle it
compares the ban list and immediately calls the LAPI to unban anything that
matches the allowlist. The cost is up to one cycle of latency; the benefit is
that it never touches CrowdSec's configuration.

### Alerts and push

Uses [Server酱](https://sct.ftqq.com/) (a Chinese WeChat push service).
**Don't put the SendKey in `config.yaml`** — use `.env`:

```bash
cp .env.example .env
echo "HOMELAB_SENDKEY=your-sendkey" >> .env
docker compose up -d
```

Keys starting with `sctp` use Server酱³, others use the Turbo endpoint; detected
automatically.

> Want a different push provider (Telegram, Bark, Gotify, ntfy)? `backend/notify.py`
> is about 60 lines with a single `send()` entry point — PRs very welcome.

Three layers keep alerts from spamming you: the `sustain_seconds` duration gate,
the `repeat_hours` reminder interval, and per-alert muting (timed or permanent,
managed in Settings). A recovery notice is sent when the condition clears.

### Port exposure audit

Every listening port is graded into three levels:

- **Public** — declared in `ports.public_ports`, shown in red
- **LAN reachable** — bound to `0.0.0.0` but not forwarded
- **Localhost only** — bound to `127.0.0.1`

If you manage allowed ports with an iptables script containing a line like
`PORTS="22,80,443"`, point `ports.homeguard_path` at it for more accurate
grading. Leave it empty to skip.

**`public_ports` must be filled in by hand** — only you know which ports your
router forwards; it isn't visible from inside the machine.

### History and trends

Minute-level samples in SQLite, 90 days by default. Charts merge metrics that
share a unit: CPU with memory, upload with download, all volumes together — a
shared Y axis is what makes them comparable.

The Y axis fits the data range but enforces a **minimum span**: storage sits at
40% for months, and pure auto-scaling would stretch a 0.1% wobble across the
whole card, making it look like the drive is about to explode.

Capacity forecasting is linear extrapolation, but **gives no answer with less
than 24 hours of data**. Extrapolating from startup noise produces a scary,
fake number — better to say "not enough data".

### Drive health

Reallocated and pending sectors turn red the moment they're non-zero — those are
*current state*, and non-zero means a real problem.

`Reported_Uncorrect` gets special handling: it's a *cumulative historical count*
that never decreases. The raw number can't tell you whether those errors happened
yesterday or six years ago. The dashboard reads the power-on timestamps from the
SMART error log, compares them against current power-on hours, and if nothing new
has appeared in over a year it's classified as ancient history — pulled out of
the alert and noted separately.

It also checks `/proc/mdstat`: many NAS systems wrap a single disk in a raid1
array, which looks redundant but is really `[1/1]`, a single member. This
"nominal redundancy" is called out explicitly.

---

## Deploying to a remote host

`deploy.sh` packages the code, uploads it, builds the image remotely and restarts
the container.

```bash
cp deploy.env.example .deploy.env
# edit .deploy.env, set HOMELAB_HOST (ssh alias or user@host)
./deploy.sh              # build and deploy
./deploy.sh --config     # also overwrite the remote config.yaml with the local one
./deploy.sh --no-build   # restart only, don't rebuild the image
```

Two gotchas:

- **`--no-build` does not update code.** `backend/` and `frontend/` are COPYed
  into the image; only `config.yaml` is mounted. Code changes require a rebuild.
- **Use `--config` when you add new config keys**, otherwise the remote won't see
  the new section. The old config is backed up as `config.yaml.bak`.

By default the remote `config.yaml` is preserved, so ad-hoc tweaks made on the
server survive deploys.

---

## Managing multiple machines

One dashboard for every machine: ban an IP in one place and have it take effect
everywhere.

The work splits in two, and **the halves are independent** — doing only the
firewall half is perfectly useful on its own:

| | Built on | What it takes |
|---|---|---|
| Unified firewall | CrowdSec's native distributed design | a few config lines, nothing to install |
| State aggregation | the dashboard pulling over SSH | one collector script per node |

### Networking first: pick your tier

Node agents need to reach the central LAPI, which means the machine hosting it
has to be reachable. From most to least secure:

1. **Private network (recommended)** — WireGuard / Tailscale / ZeroTier / LAN.
   The LAPI listens only on the private range, so the port simply doesn't exist
   on the public internet. There is no "what if my allowlist is wrong" question.
2. **Public + reverse proxy + strong auth (acceptable)** — HTTPS proxy, source-IP
   allowlist, and CrowdSec's own machine authentication. All three; drop one and
   you drop a tier.
3. **Exposing 8080 straight to the internet (don't)** — CrowdSec machine auth is
   login/password over plain HTTP. That's broadcasting your credentials.

Examples below use `10.0.0.1` for the central machine's private address.

### Unified firewall

On the **central machine**, make the LAPI listen beyond loopback:

```yaml
# /etc/crowdsec/config.yaml
api:
  server:
    listen_uri: 0.0.0.0:8080
```

Bind `0.0.0.0` rather than the private address directly: the latter makes
crowdsec's startup depend on your VPN being up first — if the VPN is late,
crowdsec fails to start and local protection goes down with it. Bind `0.0.0.0`
and restrict by firewall instead; same exposure, no ordering dependency:

```bash
# allow the private network and localhost, drop everything else
iptables -A INPUT -i lo -p tcp --dport 8080 -j ACCEPT
iptables -A INPUT -s 10.0.0.0/24 -p tcp --dport 8080 -j ACCEPT
iptables -A INPUT -p tcp --dport 8080 -j DROP
```

On **each node** — order matters. Register and confirm it works *before*
disabling the local LAPI, so there's never a window without protection:

```bash
# 1. Install CrowdSec (same as Step 1 above)
curl -s https://install.crowdsec.net | sudo sh
sudo apt-get install -y crowdsec

# 2. Register with the central LAPI. This overwrites the credentials file
sudo cp /etc/crowdsec/local_api_credentials.yaml{,.bak}
sudo cscli lapi register --machine node1 --url http://10.0.0.1:8080

# 3. [on the central machine] approve it
sudo cscli machines validate node1

# 4. Disable the local LAPI — add enable: false under api.server
#    Note the key is absent by default (defaults to true): you're adding, not editing
sudo systemctl restart crowdsec

# 5. Bouncer — configure it immediately after install. The local LAPI is already
#    off, so between install and config the bouncer is disconnected
sudo apt-get install -y crowdsec-firewall-bouncer-iptables
#    [on the central machine] cscli bouncers add node1-fw -o raw   -> api key
sudo vi /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml
#    api_url: http://10.0.0.1:8080/
#    api_key: <the key from above>
sudo systemctl restart crowdsec-firewall-bouncer
```

To verify: `cscli machines list` on the central machine should show every node
with a live heartbeat. Then ban an IP and confirm it actually lands on another
machine:

```bash
# ipset names carry a shard suffix (-0/-1/-2). Querying plain
# crowdsec-blacklists returns "set does not exist", which reads like failure
for s in $(ipset list -n | grep '^crowdsec-blacklists'); do
  ipset test $s 1.2.3.4 2>/dev/null && echo "hit in $s"
done
```

Once this works, the dashboard shows alerts from every node — **with no
dashboard configuration at all**. It reads the central machine's CrowdSec
database, and that's where all nodes write. The ban list gains a "detected by"
column.

### State aggregation (containers, disks, ports)

Everything CrowdSec doesn't cover comes over SSH. **Use a restricted key.** The
dashboard holds private keys to every node; with a forced command, a leaked key
only grants read access to monitoring data. Without one, it grants a shell on
your entire fleet.

Generate a dedicated key on the **central machine**:

```bash
mkdir -p /opt/homelab-dashboard/secrets && chmod 700 $_
ssh-keygen -t ed25519 -N "" -C "homelab-panel" \
  -f /opt/homelab-dashboard/secrets/id_panel
```

Mount it into the container (`docker-compose.override.yml`):

```yaml
services:
  homelab-dashboard:
    volumes:
      - ./secrets:/app/secrets:ro
```

On **each node**, install the collector script and pin the key to it:

```bash
sudo mkdir -p /opt/homelab
sudo install -m 755 scripts/node-collect.sh /opt/homelab/node-collect.sh

# add this line to authorized_keys, with the public key generated above
command="/opt/homelab/node-collect.sh",restrict ssh-ed25519 AAAA... homelab-panel
```

`restrict` (OpenSSH 7.2+) disables port forwarding, agent forwarding, X11, pty
and user-rc in one word. Together with `command=`, that key can do exactly one
thing. Check it:

```bash
ssh -i secrets/id_panel root@10.0.0.2 "cat /etc/shadow"
# should print the collector output, not the contents of /etc/shadow
```

Finally list the nodes in the dashboard config:

```yaml
nodes:
  - name: node1
    host: root@10.0.0.2
    key: /app/secrets/id_panel
  - name: node2
    host: root@10.0.0.3
    port: 4522              # non-standard SSH port
    key: /app/secrets/id_panel

intervals:
  nodes: 60
```

The overview page gains a "nodes" card: one row per machine with load, memory,
the fullest disk, container counts, locally enforced bans and collection
latency. Click a row to expand.

The config names an SSH target and nothing else — **no networking scheme is
baked in**. Whether you reach nodes over VPN, LAN or the public internet is not
the dashboard's business.

### Known boundaries

- **Node collection is read-only.** The dashboard never executes anything on a
  node, and the restricted key wouldn't let it. The only cross-machine action is
  banning, and CrowdSec does that itself.
- **Tabs still show the central machine.** Certificates, connections and network
  throughput aren't collected per node — partial data there would be worse than
  none, and each node can run its own dashboard if you want the detail.
- **History is central-only.** Each node keeps its own; the central machine
  aggregates current state, not time series.

---

## External watchdog

The alert engine runs on the machine being monitored, so **when that machine dies
the alerting dies with it** — silence exactly when you most need a warning.

`scripts/watchdog.sh` covers that blind spot. It must run on a *different*
always-on machine (a cheap VPS is plenty):

```bash
mkdir -p /opt/homelab-watchdog && cd /opt/homelab-watchdog
# upload watchdog.sh and watchdog.env.example
chmod +x watchdog.sh
cp watchdog.env.example watchdog.env && vi watchdog.env   # set SENDKEY and TARGETS
./watchdog.sh --test                                      # verify push works
( crontab -l 2>/dev/null; echo "*/5 * * * * /opt/homelab-watchdog/watchdog.sh" ) | crontab -
```

Probe your public entry point rather than an internal IP — that single check
verifies the machine is alive, the network is up, and the reverse proxy works.
It takes 3 consecutive failures (~15 minutes) to alert, which filters out
restarts and network blips.

---

## Troubleshooting

**It starts, but many cards say "unavailable"**

Expected. No CrowdSec means no firewall data; no smartctl means no drive data.
`docker logs homelab-dashboard` explains why each collector failed.

**Storage numbers look wrong**

Inside the container `/` is its own overlay layer, not the host root. Paths in
`config.yaml` must use `/hostfs`, not `/`.

**Ban returns 403**

Writes are locked by default, see [Step 5](#step-5-set-up-login).

**Ban succeeded but the IP still gets through**

1. Check the bouncer is installed: `sudo cscli bouncers list`
2. Wait 10 seconds — that's the polling interval
3. Check iptables: `sudo iptables -L CROWDSEC_CHAIN -n | head`
4. Make sure it isn't a protected range (private, loopback and Tailscale are refused)

**Attack sources are always empty**

CrowdSec isn't detecting anything, usually a log source misconfiguration. Run
`sudo cscli metrics` and look at "Acquisition Metrics"; `Lines parsed: 0` means a
wrong `type` label or a missing parser. See [Step 3](#step-3-tell-crowdsec-which-logs-to-read).

**Drive card says it can't list disks**

Needs `SYS_RAWIO`, the `/dev` mount, `device_cgroup_rules`, and `smartmontools`
on the host. Note that **mounting `/dev` does not by itself grant block-device
access** — those `device_cgroup_rules` lines are required.

**Container clock is off by hours**

Mount `/etc/localtime:/etc/localtime:ro` (already in the shipped compose file).

**History says "not enough data"**

The sampling window is too short. Capacity forecasting needs 24 hours; trend
charts need at least 2 samples.

---

## Architecture

```
13 collectors (independent loops) ─┬─ in-memory cache ─→ FastAPI ─→ frontend (5s poll)
                                   ├─ SQLite   metrics & events, 90-day retention
                                   └─ alert engine ─→ push ─→ phone
```

**Collection is decoupled from requests.** Slow collectors (btrfs snapshot scans
take seconds, SSH to a remote host takes a second) run in the background at their
own pace; the frontend only ever reads the cache and never waits. When a
collector fails, the last good data is retained so the card doesn't go blank.

History persistence and alert evaluation run on a separate 30-second loop rather
than following collector timing. Both are blocking (SQLite writes, HTTP pushes)
and are dispatched to a thread pool so they never stall the event loop.

### Layout

```
backend/
  main.py            FastAPI routes, auth and audit middleware
  auth.py            single-user login: sessions, password hashing, rate limiting
  hashpw.py          CLI to generate a password hash
  cache.py           collection scheduling and in-memory cache
  config.py          config loading
  alerts.py          alert rule engine, overrides, muting
  firewall.py        LAPI client and allowlist
  history.py         SQLite: metrics/events/whitelist/audit/settings
  notify.py          push notifications
  actions.py         container operations and snapshots
  asn_names.py       ISP name normalization
  collectors/        the twelve collectors
frontend/
  index.html         page skeleton
  app.css            styles
  app.js             rendering and interaction (zero dependencies)
scripts/
  watchdog.sh        external watchdog
  node-collect.sh    collector script installed on managed nodes
```

### API

Full docs at `/api/docs` (generated by FastAPI). Main endpoints:

```
GET  /api/summary                 all collector data in one call
GET  /api/section/{name}          a single collector
GET  /api/history/multi           multiple series
POST /api/firewall/ban            ban
POST /api/firewall/unban          unban
POST /api/containers/{name}/{action}   container operations
PUT  /api/alerts/settings         edit alert rules
```

Write operations require the `X-Panel-Token` header when `write_token` is set.

---

## Development

Run it without Docker:

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
python run.py
```

The frontend has no build step — edit the files under `frontend/` and refresh.

Note that when running outside a container the `/hostfs` path assumption doesn't
hold, so point `storage.volumes` at real paths.

---

## Roadmap

Done: SQLite history, storage growth forecasting, network and load charts,
attack-source aggregation with one-click bans, container restart and logs, push
alerting, external watchdog, port exposure audit, access audit, UI-editable alert
rules, drive SMART monitoring, ISP and scenario name normalization, dashboard
login, multi-machine management (multi-node CrowdSec + SSH state collection).

Not yet:

- Per-container detail page — historical resource usage for a single container
- Real snapshot deletion — currently generates a command. Login makes this
  feasible now, though granting delete rights still deserves more thought
- Per-node history — only current state is aggregated; each node's time series
  stays on that node
- **UI internationalization — the interface is currently Chinese only**
- Mobile layout polish — usable, but wide tables scroll awkwardly

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

Especially interested in:

- **Other distros / NAS platforms** — path differences on Synology, QNAP, unRAID
- **UI translation** — the interface is Chinese only today; English would be a
  great first contribution
- **New push providers** — Telegram, Bark, Gotify, ntfy; `notify.py` is tiny
- **New collectors** — the interface is one `collect(cfg)` function returning a dict

---

## License

[MIT](LICENSE)
