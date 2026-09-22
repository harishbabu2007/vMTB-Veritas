"""stt-service: streaming speech-to-text for the vMTB transcription pipeline.

A single FastAPI service exposing a WhisperLive-compatible WebSocket endpoint.
The opus-transcriber-proxy connects here and streams mono PCM16 @ 16 kHz; we
transcribe with faster-whisper and answer with:

    {"message": "partial", "transcript": "..."}
    {"message": "final",   "transcript": "..."}

End-of-stream handshake (sent by the proxy when the meeting ends):

    client -> server: {"message": "end_of_stream"}
    server -> client: {"message": "final", "transcript": "..."}   # if audio remains
    server -> client: {"message": "end_of_stream_done"}

Endpoints
---------
GET /health        liveness (always 200 once the process is up)
GET /ready         readiness (200 only after the model is loaded)
WS  /client/ws/speech   streaming endpoint
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from .config import settings
from .streaming import StreamingBuffer
from .transcribe import Transcriber, WhisperTranscriber

logger = logging.getLogger("stt-service")

# Number of concurrent transcription runs we allow. CTranslate2 batches are not
# safe to share across threads; serialise per instance. Raise when GPU multisteam
# is added.
MAX_CONCURRENT = 1


def create_app(transcriber: Transcriber | None = None, *, stt_settings=None) -> FastAPI:
    cfg = stt_settings or settings
    engine: Transcriber | None = transcriber

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal engine
        if engine is None:
            # Load lazily at startup so tests (which inject a fake) never pull
            # in the ML stack. Model is downloaded on first load; in production
            # it is baked into the image at build time (see Dockerfile).
            engine = WhisperTranscriber(
                model=cfg.model,
                language=cfg.language,
                device=cfg.device,
                compute_type=cfg.compute_type,
                beam_size=cfg.beam_size,
            )
        app.state.engine = engine
        app.state.started = time.time()
        app.state.total_sessions = 0
        yield
        engine = None

    app = FastAPI(title="stt-service", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/ready")
    async def ready():
        engine_ = app.state.engine
        if engine_ is None:
            return {"status": "loading"}
        return {"status": "ok", "model": cfg.model, "device": getattr(engine_, "device", "unknown")}

    @app.get("/metrics")
    async def metrics():
        return {
            "model": cfg.model,
            "device": getattr(app.state.engine, "device", "unknown"),
            "language": cfg.language or "auto",
            "sessions": app.state.total_sessions,
        }

    @app.websocket("/client/ws/speech")
    async def speech(ws: WebSocket):
        await ws.accept()
        app.state.total_sessions += 1

        buffer = StreamingBuffer(
            sample_rate=cfg.sample_rate,
            chunk_threshold_samples=int(cfg.sample_rate * cfg.chunk_threshold_seconds),
            min_commit_words=cfg.min_commit_words,
        )

        await _send(ws, {"message": "info", "info": {"model": cfg.model, "language": cfg.language or "auto"}})

        last_run = time.monotonic()
        last_forced = last_run
        idle_timeout = cfg.idle_timeout_seconds
        end_of_stream = False
        try:
            while True:
                # Idle watchdog: a client that vanishes without a clean close
                # would otherwise hold this (billable) GPU instance until the
                # platform request timeout. Silence longer than the configured
                # window ends the session; the final flush below still runs.
                if idle_timeout > 0:
                    try:
                        message = await asyncio.wait_for(ws.receive(), timeout=idle_timeout)
                    except asyncio.TimeoutError:
                        logger.info("ws: idle timeout (%ss), closing session", idle_timeout)
                        break
                else:
                    message = await ws.receive()

                if message["type"] == "websocket.disconnect":
                    break

                if message["type"] != "websocket.receive":
                    continue

                if message.get("bytes"):
                    buffer.add(message["bytes"])
                elif message.get("text"):
                    if _is_end_of_stream(message["text"]):
                        # Proxy-initiated end of meeting: flush while the socket
                        # is still open so the final tail actually arrives.
                        end_of_stream = True
                        break
                    # Other text frames are ignored (protocol is binary audio
                    # plus the JSON control messages we understand).

                now = time.monotonic()
                force = now - last_forced >= cfg.max_between_runs_seconds
                if buffer.enough_audio_to_run or force:
                    last_forced = now
                    if buffer.audio.size > 0:
                        results = await run_in_threadpool(buffer.run, app.state.engine)
                        for r in results:
                            await _send(ws, {"message": "final" if r.is_final else "partial", "transcript": r.text})
                    last_run = now

        except WebSocketDisconnect:
            pass
        except Exception:
            # Never skip the final flush because of an unexpected receive-loop
            # error (a missed flush truncates the end of every meeting).
            logger.exception("ws: receive loop failed; attempting final flush")

        # Final flush: commit whatever audio is left as one final segment.
        # - end_of_stream path: the socket is still open, so the send succeeds.
        # - disconnect path: best-effort; the client may already be gone.
        try:
            final = await run_in_threadpool(buffer.flush_final, app.state.engine)
            if final:
                sent = await _send(ws, {"message": "final", "transcript": final.text})
                if not sent:
                    logger.warning("ws: final flush result could not be delivered (client gone)")
            if end_of_stream:
                await _send(ws, {"message": "end_of_stream_done"})
                try:
                    await ws.close()
                except Exception:
                    pass
        except Exception:
            logger.exception("ws: final flush failed")

    return app


def _is_end_of_stream(raw: str) -> bool:
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return False
    return isinstance(payload, dict) and payload.get("message") == "end_of_stream"


async def _send(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        # Client gone mid-send; nothing sensible to do. Callers that expect
        # the socket to still be open (end_of_stream path) log a warning.
        logger.debug("ws: send failed (client gone): %s", payload.get("message"))
        return False


app = create_app()

if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, log_level=settings.log_level)
