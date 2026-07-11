# SillyTavern Multiplayer Plugin

Private, friend-focused multiplayer rooms for SillyTavern.

Each participant keeps their own local SillyTavern instance. This extension connects outward to a private VPS Relay over WSS. The Relay coordinates rooms and shared story events; the host's local SillyTavern remains the only source of AI generation and the full private prompt context.

## V1 scope

- Host-reviewed text actions for 2–6 friends.
- A plugin-side shared story timeline, proposal queue, and side chat.
- A private WSS Relay for invitations, room membership, ordering, and reconnects.
- Host-only writes to the selected local chat and host-only AI generation.

V1 deliberately excludes general attachments, voice, host migration, peer-to-peer generation, and any writes to a guest's own chats or characters. The guest-side story renders in a dedicated plugin-managed mirror chat — the primary guest interface, gated on an up-front technical validation — while a slim control-center panel handles rooms, proposals, and side chat; the host may explicitly share the character card to the room (see `docs/V1-PLAN.md`, phases P1 and P3).

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
src/card-sharing.js   Full character-card share/import over the relay asset channel
src/save-sharing.js   Co-op chat save (jsonl) share/import over the relay asset channel
src/relay-http.js     Shared asset-channel HTTP helpers (auth headers, hashing)
src/kick-command.js   room.kick command construction and validation
src/ui.js             Extension UI shell
src/protocol.js       Shared browser-side protocol constants
```

The matching relay service lives in the sibling `sillytavern-multiplayer-relay` repository. The cross-repo V1 execution plan is maintained at `sillytavern-multiplayer-relay/docs/V1-PLAN.md`; the plugin-side module plan and the canonical protocol command table live in `docs/V1-PLAN.md` in this repository.

## Status

Phases P0 and P1 are code-complete. P0 delivered the protocol vocabulary, invite-code utilities, and `src/relay-client.js` (request/ack correlation, exponential-backoff reconnection, heartbeat dead-connection detection). P1 delivered the mirror-mode feasibility validation (`docs/MIRROR-FEASIBILITY.md`, all four local checks feasible on SillyTavern 1.16.0), the full `src/room-store.js` event reducer (members / proposals / timeline / side chat projections, seq-gap detection with `room.resume` recovery), and the floating control-center window in `src/ui.js` (opened via a draggable floating ball; join/create room, member list with presence, proposal editor and host review queue, side chat, collapsed debug timeline). Room sharing now covers both the full character card and the co-op chat save: the host shares the current chat's jsonl (`src/save-sharing.js`, published as a `kind=chat` asset via `room.chat.update`), guests auto-import it under the mirrored character so a half-played session can resume another day. Both shares carry `cardKey`/`saveKey` + `contentHash` dedup metadata — unchanged content skips upload/import, and the same card or save reuses the same local file across rooms instead of piling up copies. The data layer is script-verified end-to-end by `scripts/smoke-client.mjs` against a live relay; the remaining P1 acceptance item is a manual two-player test inside SillyTavern. Next: host chat bridging (P2), then the mirror chat itself (P3), per `docs/V1-PLAN.md`.

