# Upstream Sync Memo

## Upstream: MrCreativ3001/moonlight-web-stream
- Remote name: `upstream`
- Last commit checked: `9e2fed0` (upstream/master) — "Improve mobile screen keyboard handling (#137)"
- Date of sync review: 2025-07-09
- Merge base: `653558efddb7958419a129f06b6fc1965b1d2d9d`
- Total commits ahead at time of review: 514

## Structure Difference
Upstream restructured paths in v2:
- `moonlight-web/web-server/web/` → `web/`
- `moonlight-web/streamer/` → `streamer/`
- `moonlight-web/web-server/src/` → `src/`

Our fork keeps the old path structure.

## Commits Ported

| Commit | Description | Notes |
|--------|-------------|-------|
| 8c86da6 | Improve touch pointer interactions | touchGestureSuppressClick, touch cleanup |
| 9652280 | Suppress touch clicks after pointer movement | Part of touch fix series |
| 9539f31 | Prevent touch gestures from producing stray clicks | Part of touch fix series |
| 55e5ebf | Accumulated scrolling for mouse+touch, sendText buffer fix | Mouse wheel + touch scroll accumulation, buffer.reset() in sendText |
| 75f9d0a | Controller channel buffering check | Added readyState check in onGamepadConnect |
| 9e2fed0 | Screen keyboard rewrite | textarea, sentinel, compositionend, floating button |
| 1a4f093 | Modal abort race condition fix | Use local abortController ref |
| 6a3c406 | AbortController polyfill | New polyfill files for Tesla browser compatibility |
| 44b95ba | Paste text to host | Ctrl+V passthrough + onPaste handler (minus raiseAllKeys which doesn't exist) |
| 882eafa | F11 fullscreen passthrough | Allow browser-native F11 |
| 2197926 | Mouse buttons X1/X2 | Extended StreamMouseButton + BUTTON_MAPPINGS |
| 716042a | More keyboard keys | Enabled PageUp, Delete, End, PageDown, NumpadDivide, Home, Insert |
| 50fe9af | navigator.keyboard.lock in iframe | requestKeyboardLock helper for iframe environments |

## Commits Skipped (with reasons)

### Not applicable to our architecture
- **WebSocket transport commits** (ac37db5 etc.): We use WebRTC only
- **libopenh264/libopus WASM decoders**: Tesla has native codec support
- **Multi-user auth/roles/admin** (d98793f-3c61a9f): We use single-user TOTP auth
- **i18n system** (multiple): Not needed for single-user Tesla use
- **Docker/CI commits** (bb73052, ea6be14, etc.): Infrastructure-specific
- **Rust streamer changes** (7611bdf, bbde312, etc.): Our streamer layer is different
- **v2 migration** (c4af773 onwards): Complete rewrite of server architecture

### Already applied or not needed
- 772a41c (video size for stream rect): Uses VideoElementRenderer class not in our fork
- 0a9d16c (WebRTC signaling race): Rust transport layer completely different
- 240ed9a (document-level event listeners): Already in our code
- 73b57ae (video min-width/min-height 100vmin): Already applied
- 8e1bf00 (mouse move based on screen size): Already have sendMouseMoveClientCoordinates
- 229365d (smooth touch scrolling): Superseded by accumulated scroll approach
- f4391f6 (touch relative mode scroll fix): Already applied
- 3a8c738 (keys in fullscreen/pointer lock): Already have document listeners + input div
- 2e73f39 (stopPropagationOn helper): Already have it
- 81ee2e5 (sidebar touch fix): Already applied
- db30f6c (gamepad vibration Safari fix): Already have collectActuators
- 51367f4 (key events sent twice): Already have stopPropagation in all handlers
- 0218191 (fullscreen support check): Already handled
- 81b1393 (unadjusted movement): Already have it
- ce3a7ea (text field overflow fix): Already in styles.css
- c352f60 (window.errors displayed): Already have error/rejection handlers
- 23bce22 (screen keyboard backspace): Superseded by full rewrite (9e2fed0)

### Not relevant for Tesla browser
- 98c86c4 (iOS right-click polyfill): Safari-only, uses navigator.vendor check
- adb8256 (PWA/add to homescreen): Not useful on Tesla
- 4f44c03 (fullscreen-triggered remote input): v2 architecture feature
- a62764f (auto fullscreen on first remote input): v2 feature addition
- cb171ab (stacked action buttons fix): v2 CSS structure

### Cosmetic/README/Docs
- 0140714, b269a43, 6f58578, 0cd6961, 9e1c3a1, etc.

## How to Repeat This Process

1. `git fetch upstream`
2. Check new commits: `git log upstream/master --oneline --reverse | Select-Object -Skip N` (where N was 514 last time)
3. For each commit, check if it touches web frontend: `git show <hash> --stat`
4. If relevant, get diff: `git show <hash> -- moonlight-web/web-server/web/ web/`
5. Adapt path from upstream's `web/` to our `moonlight-web/web-server/web/`
6. After porting, run `npm run build-light` in `moonlight-web/web-server/`
7. Update this memo with new commits ported/skipped
