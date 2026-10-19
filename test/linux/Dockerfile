# syntax=docker/dockerfile:1.7
#
# Linux end-to-end image for the workflow runtime.
#
# Why an image: the read-only verification backend needs a real Linux kernel
# with unprivileged user namespaces (bubblewrap), and the live E2Es need tmux,
# ps and a non-root user. None of that can be smuggled into a macOS host, and a
# sandbox-less run is not acceptance evidence.
#
# The container itself is deliberately *not* privileged: the runner starts it
# with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined`
# only so that a nested bubblewrap can create its own namespaces. Each
# verification command then runs inside bwrap's own isolation (all namespaces
# unshared, root bound read-only, only its private scratch writable), so the
# command has no sockets and no writable workspace.
#
# Build context is the repository root (see test/linux/run).
FROM node:22-bookworm

ARG PI_CLI_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_CLI_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive \
    PI_OFFLINE=1 \
    PI_REQUIRE_READONLY_SANDBOX=1 \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent

# bubblewrap is the backend; procps provides the ps/kill the wrapper's watchdog
# uses; tmux, git and ca-certificates are what the terminal suites and pi need.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap procps python3 tmux git ca-certificates rsync \
 && rm -rf /var/lib/apt/lists/*

# The published CLI, not this package's peer dependency: the E2Es must exercise
# the same runtime a user installs. PI_OFFLINE=1 (above) keeps that binary from
# reaching for updates while the tests run.
RUN mkdir -p /usr/local/share/pi-cli \
 && npm install --global --no-audit --no-fund "$PI_CLI_PACKAGE@$PI_CLI_VERSION" \
 && npm ls -g --depth=0 --json "$PI_CLI_PACKAGE" > /usr/local/share/pi-cli/installed.json \
 && node -e "const j=require('/usr/local/share/pi-cli/installed.json');process.stdout.write(j.dependencies['@earendil-works/pi-coding-agent'].version+'\n')" > /usr/local/share/pi-cli/version.txt \
 && chmod -R a+rX /usr/local/share/pi-cli \
 && npm cache clean --force

# Workspace dependencies from the repository lockfile. The host's node_modules
# is never mounted or reused: it carries macOS native binaries.
WORKDIR /opt/pi-deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && npm cache clean --force \
 && chmod -R a+rX /opt/pi-deps

COPY test/linux/entrypoint.sh /usr/local/bin/pi-linux-entrypoint
RUN chmod 0755 /usr/local/bin/pi-linux-entrypoint

# The entrypoint stages the read-only mount here; the non-root user must own it.
RUN mkdir -p /work && chown node:node /work

# Pre-create the sessions directory: Docker auto-creates a missing bind-mount
# target as root, which would leave $HOME/.pi/agent unwritable for the node user
# and make the credential copy fail.
RUN mkdir -p /home/node/.pi/agent/sessions && chown -R node:node /home/node/.pi

# Non-root execution: the base image's node user (uid/gid 1000).
USER node
ENV HOME=/home/node
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/pi-linux-entrypoint"]
CMD ["bash", "-c", "npm test"]
