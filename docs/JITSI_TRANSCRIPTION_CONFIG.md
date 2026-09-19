# Jitsi Transcription Config (Prosody/Jicofo wiring on the VM)

The proxy, STT service and worker are repo-side components (see
`docs/MEETING_TRANSCRIPTION_PIPELINE.md`). The bridge-based transcription
*initiation* happens inside the running Jitsi stack (the JVB VM — see
`docs/JITSI_VM_OPERATIONS.md` for creating/operating that VM), which is
**not part of this repository**. This document explains what needs to
change there and how the pieces talk to each other.

Source of truth for the bridge transcription path:
<https://jitsi.github.io/handbook/docs/devops-guide/transcription/>

## Overview

With bridge-based transcription:

1. **Prosody** (XMPP server) tells Jicofo that transcription is enabled for a
   conference and forwards the meeting id.
2. **Jicofo** opens a WebSocket to the transcription URL template, substituting
   `{{MEETING_ID}}` with the Jitsi conference meeting id.
3. **JVB** connects to the proxy over that WebSocket and streams participant
   audio as tagged Opus frames.
4. The proxy is our `opus-transcriber-proxy` Cloud Run service; the rest of the
   pipeline runs downstream of it.

## 1. Prosody — enable transcription

Transcription is gated by room metadata (`asyncTranscription`), which clients
cannot set themselves — it must be forced server-side. The standard approach
is a small Prosody module (`mod_force_async_transcription.lua`) hooked on the
conference MUC component; see **`docs/DEPLOYMENT.md` §6.5** for the exact
copy-paste module and config, and `docs/JITSI_VM_OPERATIONS.md` Part 4 for
the equivalent once the VM is on the `meet.vmtb.in` custom domain.

Reference: <https://jitsi.github.io/handbook/docs/devops-guide/transcription/>

## 2. Jicofo — point transcription at the proxy

In `jicofo.conf`, inside the top-level `jicofo { ... }` block:

```
jicofo {
  transcription {
    url-template = "wss://PROXY_URL/transcribe?sessionId={{MEETING_ID}}&sendBack=true"
    ping {
      enabled = true
      interval = 10 seconds
      timeout = 3 seconds
    }
  }
}
```

- `{{MEETING_ID}}` is the Jitsi conference meeting id. This is the value the
  proxy stores as `meeting_id` in Supabase. It is **not** `meeting_sessions.id`
  and not `mtb_id`.
- `sendBack=true` makes JVB expect `transcription-result` messages back, which
  the proxy sends for captions.
- `PROXY_URL` is the public URL of `opus-transcriber-proxy` on Cloud Run.

## 3. jitsi-meet — enable the UI toggle

In `config.js`:

```js
transcription: {
    enabled: true,
    // optional: hide the language picker / set a default
    // transcriptionLanguages: { 'en': 'English', 'hi': 'Hindi' }
},
```

Users (or the admin, via moderation) can then start transcription from the
meeting UI. Transcripts appear as captions when `sendBack=true` is set.

## 4. Meeting-end signal

The proxy treats the JVB WebSocket closing as "meeting ended". It then:
- ensures the `meeting_transcripts` row exists (PENDING), and
- publishes `{"event":"meeting.completed","meeting_id":...,"mtb_id":null}` to
  Pub/Sub, which triggers `transcript-worker`.

No change is required on the JVB side for the end-of-meeting path.

## 5. Mapping the meeting back to an MTB (follow-up)

In the MVP, `mtb_id` stays NULL: the pipeline only knows the JVB meeting id, and
`meeting_sessions`/`mtb_id` are stored by `meetingAnalytics.ts` under the *room
name*, not the conference id. To populate `mtb_id` later, pick one of:

1. **Prosody room metadata** — the conference can include structured
   `transcription.urlParams` (e.g. `mtb_id`) that Jicofo appends to the URL
   template. The proxy would then read `mtb_id` from the query string. This is
   the cleanest option and is already supported by Jicofo's URL template
   (`{{MEETING_ID}}` and extra query params).
2. **Reconciliation job** — after the meeting, match on `room_name` + start-time
   window between `meeting_sessions` and the transcript row's timestamps.

## 6. Example: full request path for one meeting

```
Jitsi Meet UI: user enables transcription
  └─ config.js transcription.enabled=true
Prosody: room metadata transcription.enabled=true
Jicofo: ws://PROXY_URL/transcribe?sessionId=<conf-id>&sendBack=true
JVB:    ws session open -> ping / start(tag) / media(tag, base64 opus)
Proxy:  decodes, streams PCM16 to stt-service, stores FINAL segments
        (meeting_transcript_segments), echoes transcription-result back
JVB:    session close -> proxy publishes meeting.completed
Worker: claims -> GCS artifacts -> LLM MoM -> COMPLETED
```

## 7. Verification

After wiring, the quickest check is:

1. Start a meeting in `jitsi-frontend`.
2. Start transcription from the meeting UI.
3. Watch the proxy logs for `ws: transcription session opened` with your
   sessionId.
4. In Supabase, confirm `meeting_transcript_segments` rows appear for the
   meeting id, and `meeting_transcripts` transitions PENDING → COMPLETED after
   the meeting ends.