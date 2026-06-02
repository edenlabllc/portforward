# port-forward

Tiny zero-dependency CLI for keeping Kubernetes `kubectl port-forward` sessions alive from a repo-local config.

## Install

One line — downloads the prebuilt standalone binary, no bun needed:

```bash
curl -fsSL https://raw.githubusercontent.com/edenlabllc/portforward/main/get.sh | sh
```

This installs `portforward` to `~/.local/bin`. Override with `PORTFORWARD_BIN_DIR=/usr/local/bin`, or pin a version with `PORTFORWARD_VERSION=v1.2.3`.

`kubectl`, `lsof`, and `pkill` must be available at runtime.

### Update

```bash
portforward upgrade        # fetch and install the latest release in place
portforward version        # show installed version
```

`upgrade` replaces the running binary with the latest release for your platform. Re-running the `curl … | sh` line does the same thing.

### From source

With bun installed, build and install a binary locally:

```bash
git clone https://github.com/edenlabllc/portforward port-forward
cd port-forward
./install.sh              # compiles dist/portforward and installs it
# or just: bun run build  # produces dist/portforward
```

> No `bun install` is required — the project has no runtime dependencies.

## Releasing

Push a tag and GitHub Actions cross-compiles all platforms and attaches them to the Release:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Released binaries know their own repo and version, so `portforward upgrade` and `portforward version` work out of the box.

## Usage

```bash
portforward init
portforward check
portforward start
```

`start` reads the first config it finds:

- `portforward.yaml`
- `portforward.yml`
- `.portforward.yaml`
- `.portforward.yml`
- `.workspace.yaml`

## Config

```yaml
name: local-dev

services:
  api:
    namespace: default
    localPort: 8080
    remotePort: 8080
  postgres:
    namespace: default
    localPort: 5432
    remotePort: 5432
```

If `pod` is omitted, the service key is used as the pod lookup term. Pod lookup uses exact match, then prefix match, then substring match.

You can also be explicit:

```yaml
services:
  api:
    namespace: default
    pod: api-deployment
    localPort: 8080
    remotePort: 8080
```

Or forward to a Kubernetes Service resource:

```yaml
services:
  api:
    namespace: default
    service: api
    localPort: 8080
    remotePort: 8080
```

## Monitoring

`start` checks local ports with `lsof`, reclaims stale `kubectl port-forward` processes for the same local port, and reconnects with backoff when a connection drops.
