# guciobot HTTP API

Reference for guciobot's HTTP management API. This document is part of the
API contract: every endpoint added or changed must be reflected here and in
`src/api/openapi.ts` in the same change (see the HTTP API section of
`RULES.md`).

## Overview

The API is a small [Hono](https://hono.dev) app served with `Bun.serve`,
running in the same process as the Discord bot. It exposes the music queue
over HTTP — the same operations the slash commands perform — so the bot can
be driven from scripts, other bots, or a web UI without going through
Discord.

The code lives in `src/api/`: `index.ts` builds the Hono app and starts the
server, `music.ts` holds the `/api/music/*` route handlers (thin wrappers
over `queueManager` and `DiscordBot`), and `openapi.ts` holds the
machine-readable spec. The server starts automatically with the bot and
logs its URL on startup.

Slash-command mapping:

| Slash command | API endpoint |
|---|---|
| `/play` | `POST /api/music/play` |
| `/playnext` | `POST /api/music/playnext` |
| `/skip` | `POST /api/music/skip` |
| `/kolejka` | `GET /api/music/queue` |
| `/coleci` | `GET /api/music/nowplaying` |
| `/shuffle` | `POST /api/music/shuffle` |
| `/clearlist` | `POST /api/music/clear` |
| — (no slash equivalent) | `POST /api/music/pause`, `POST /api/music/resume` |

## Configuration

Read through `src/config.ts`, like every other environment-driven value:

| Variable | Default | Description |
|---|---|---|
| `API_HOST` | `127.0.0.1` | Bind address for the HTTP server. |
| `API_PORT` | `8787` | Port for the HTTP server. |

**Security:** the API has **no authentication**. It binds to localhost by
default on purpose — anyone who can reach the socket can control the music
queue. Setting `API_HOST=0.0.0.0` exposes it to the network; do that only
on a trusted LAN.

## Conventions

- Base URL: `http://127.0.0.1:8787` (with the default config).
- All requests and responses are JSON (`Content-Type: application/json`).
- Errors share one shape: `{"error": "<message>"}`.
- Error messages are Polish — they mirror the bot's Discord replies, which
  are user-facing. Everything else in the API layer is English.
- Status codes used:

| Code | Meaning |
|---|---|
| 200 | OK |
| 202 | Accepted — songs were queued (`play`, `playnext`) |
| 400 | Validation failed, unresolvable link, or malformed JSON |
| 404 | Unknown route |
| 409 | Conflicting state (e.g. pausing when nothing is playing) |
| 502 | Voice-channel join failed |
| 500 | Unexpected error |

- A malformed JSON body on any `POST` that takes a JSON body returns
  `400 {"error": "Nieprawidłowy JSON."}`.
- An unknown route returns `404 {"error": "Not found"}`.

### Video payload

Several endpoints return queued or playing videos. The shape is always:

| Field | Type | Description |
|---|---|---|
| `url` | string | Canonical YouTube URL. |
| `title` | string | Video title. |
| `duration` | number | Length in seconds. |
| `durationString` | string | Human-readable length, e.g. `"3:33"`. |
| `startSeconds` | number, optional | Seek offset, present only when a start time was requested. |

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up (Official Video)",
  "duration": 213,
  "durationString": "3:33"
}
```

## Machine-readable spec

`GET /api/openapi.json` returns a hand-written OpenAPI 3.1 document covering
every endpoint in this file. Feed it to Swagger UI or any OpenAPI-aware
client generator.

```bash
curl http://127.0.0.1:8787/api/openapi.json
```

## GET /api/health

Liveness check. No input, no side effects.

**Request:** no body, no parameters.

**Success — 200:**

```json
{
  "status": "ok",
  "uptimeSeconds": 3612
}
```

```bash
curl http://127.0.0.1:8787/api/health
```

**Errors:** none beyond the global ones.

## GET /api/music/nowplaying

What the player is doing right now. Equivalent to `/coleci`.

**Request:** no body, no parameters.

**Success — 200:**

```json
{
  "status": "playing",
  "video": {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up (Official Video)",
    "duration": 213,
    "durationString": "3:33"
  }
}
```

`status` is one of `idle`, `buffering`, `playing`, `paused`. When idle,
`video` is `null`:

```json
{
  "status": "idle",
  "video": null
}
```

```bash
curl http://127.0.0.1:8787/api/music/nowplaying
```

**Errors:** none beyond the global ones.

## GET /api/music/queue

The current queue, in play order. Equivalent to `/kolejka`. Does not
include the currently playing video.

**Request:** no body, no parameters.

**Success — 200:**

```json
{
  "size": 2,
  "videos": [
    {
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up (Official Video)",
      "duration": 213,
      "durationString": "3:33"
    },
    {
      "url": "https://www.youtube.com/watch?v=9bZkp7q19f0",
      "title": "PSY - GANGNAM STYLE(강남스타일) M/V",
      "duration": 253,
      "durationString": "4:13"
    }
  ]
}
```

```bash
curl http://127.0.0.1:8787/api/music/queue
```

**Errors:** none beyond the global ones.

## POST /api/music/play

Resolve a YouTube URL (single video or playlist) and append it to the
queue, starting playback if nothing is playing. Equivalent to `/play`.
Playlists are expanded and added in order, up to the queue cap of 100 —
videos past the cap are dropped and counted in `skipped`.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | YouTube video or playlist URL. |
| `start` | string | no | Start timestamp, e.g. `"1:23"` or `"83"`. Single-song adds only; an invalid value is silently ignored. |
| `voiceChannelId` | string | no | Discord voice channel ID to join when the bot isn't connected to voice. |

**Success — 202:**

```json
{
  "added": [
    {
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up (Official Video)",
      "duration": 213,
      "durationString": "3:33",
      "startSeconds": 83
    }
  ],
  "skipped": 0,
  "queueSize": 1
}
```

```bash
curl -X POST http://127.0.0.1:8787/api/music/play \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "start": "1:23"}'
```

**Errors:**

| Code | Body | Cause |
|---|---|---|
| 400 | `{"error": "Pole \"url\" jest wymagane."}` | `url` missing from the body. |
| 400 | `{"error": "Nie udało się rozpoznać linku (yt-dlp)."}` | yt-dlp couldn't resolve the URL. |
| 400 | `{"error": "Nieprawidłowy JSON."}` | Malformed JSON body. |
| 409 | `{"error": "Bot nie jest połączony z kanałem głosowym — podaj voiceChannelId."}` | Bot isn't in a voice channel and no `voiceChannelId` was given. |
| 502 | `{"error": "Nie udało się połączyć z kanałem głosowym."}` | Joining the given voice channel failed. |

## POST /api/music/playnext

Like `POST /api/music/play`, but inserts at the **head** of the queue
instead of the tail, so the added songs play next. Playlist order is
preserved within the inserted block. Equivalent to `/playnext`.

**Request body:** identical to `POST /api/music/play`.

**Success — 202:** same shape as `play`:

```json
{
  "added": [
    {
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up (Official Video)",
      "duration": 213,
      "durationString": "3:33"
    }
  ],
  "skipped": 0,
  "queueSize": 3
}
```

```bash
curl -X POST http://127.0.0.1:8787/api/music/playnext \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

**Errors:** identical to `POST /api/music/play`.

## POST /api/music/skip

Skip the currently playing song. Equivalent to `/skip`.

**Request:** no body.

**Success — 200:**

```json
{
  "skipped": {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up (Official Video)",
    "duration": 213,
    "durationString": "3:33"
  },
  "nowPlaying": {
    "url": "https://www.youtube.com/watch?v=9bZkp7q19f0",
    "title": "PSY - GANGNAM STYLE(강남스타일) M/V",
    "duration": 253,
    "durationString": "4:13"
  },
  "status": "playing"
}
```

`skipped` is the video that was interrupted (`null` if nothing was
playing), `nowPlaying` is what the player moved on to (`null` if the queue
ran out), and `status` is the resulting player status
(`idle`/`buffering`/`playing`/`paused`).

```bash
curl -X POST http://127.0.0.1:8787/api/music/skip
```

**Errors:** none beyond the global ones (skipping with nothing playing is
not an error — `skipped` is simply `null`).

## POST /api/music/shuffle

Shuffle the queue in place. Equivalent to `/shuffle`. Does not affect the
currently playing song.

**Request:** no body.

**Success — 200:**

```json
{
  "shuffled": true,
  "size": 2
}
```

`size` is the number of videos in the queue after shuffling.

```bash
curl -X POST http://127.0.0.1:8787/api/music/shuffle
```

**Errors:** none beyond the global ones.

## POST /api/music/clear

Empty the queue. Equivalent to `/clearlist`. Does not stop the currently
playing song.

**Request:** no body.

**Success — 200:**

```json
{
  "cleared": true,
  "removed": 2
}
```

`removed` is the number of videos that were dropped from the queue.

```bash
curl -X POST http://127.0.0.1:8787/api/music/clear
```

**Errors:** none beyond the global ones.

## POST /api/music/pause

Pause playback.

**Request:** no body.

**Success — 200:**

```json
{
  "status": "paused"
}
```

```bash
curl -X POST http://127.0.0.1:8787/api/music/pause
```

**Errors:**

| Code | Body | Cause |
|---|---|---|
| 409 | `{"error": "Nic nie jest odtwarzane."}` | Nothing is currently playing. |

## POST /api/music/resume

Resume paused playback.

**Request:** no body.

**Success — 200:**

```json
{
  "status": "playing"
}
```

```bash
curl -X POST http://127.0.0.1:8787/api/music/resume
```

**Errors:**

| Code | Body | Cause |
|---|---|---|
| 409 | `{"error": "Odtwarzanie nie jest wstrzymane."}` | Playback isn't paused. |

## Adding an endpoint

Docs are part of the feature — an undocumented endpoint is an incomplete
change. Per the **HTTP API** section of `RULES.md`, every new or changed
endpoint **must** be documented in the same change in both places:

1. **`docs/API.md`** (this file) — a section with a short description, the
   request body table, a realistic success example, a curl example against
   `http://127.0.0.1:8787`, and the exact error bodies.
2. **`src/api/openapi.ts`** — the OpenAPI 3.1 entry, served at
   `GET /api/openapi.json`.

Keep the contract stable: error messages are Polish (they mirror the
Discord replies), errors use the `{"error": "<message>"}` shape, and status
codes follow the table in [Conventions](#conventions).
