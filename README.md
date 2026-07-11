# SillyTavern Multiplayer Plugin

Private, friend-focused multiplayer rooms for SillyTavern.

Each participant keeps their own local SillyTavern instance. This extension connects outward to a private VPS Relay over WSS. The Relay coordinates rooms and shared story events; the host's local SillyTavern remains the only source of AI generation and the full private prompt context.

## V1 scope

- Host-reviewed text actions for 2–6 friends.
- A plugin-side shared story timeline, proposal queue, and side chat.
- A private WSS Relay for invitations, room membership, ordering, and reconnects.
- Host-only writes to the selected local chat and host-only AI generation.

V1 deliberately excludes general attachments, voice, host migration, peer-to-peer generation, and any writes to a guest's own chats or characters. The guest-side story can render in a dedicated plugin-managed mirror chat, and the host may explicitly share the character card to the room (see `docs/V1-PLAN.md`, phase P3).

## Development installation

Clone this repository into the local user's third-party extensions directory, for example:

```text
SillyTavern/data/default-user/extensions/sillytavern-multiplayer-plugin
```

Then reload SillyTavern and enable the extension. During development, configure the Relay URL in the extension panel.

## Layout

```text
index.js              Extension entry point
manifest.json         SillyTavern extension manifest
src/relay-client.js   WSS connection and reconnect boundary
src/room-store.js     Local read-only room projection
src/host-bridge.js    Host-only bridge to the native ST chat and generation APIs
src/ui.js             Extension UI shell
src/protocol.js       Shared browser-side protocol constants
```

The matching relay service lives in the sibling `sillytavern-multiplayer-relay` repository. The cross-repo V1 execution plan is maintained at `sillytavern-multiplayer-relay/docs/V1-PLAN.md`; the plugin-side module plan and the canonical protocol command table live in `docs/V1-PLAN.md` in this repository.

## Status

Phase P0 (protocol and connection layer) is complete: the command vocabulary and invite-code utilities live in `src/protocol.js`, and `src/relay-client.js` provides request/ack correlation, automatic reconnection with exponential backoff, and heartbeat-based dead-connection detection (validated by `scripts/smoke-client.mjs`). Room UI (P1) and host chat bridging (P2) follow per `docs/V1-PLAN.md`.

