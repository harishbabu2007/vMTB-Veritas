from fastapi.testclient import TestClient
import json
import numpy as np

from app.config import Settings
from app.main import create_app
from app.streaming import StreamingBuffer
from app.transcribe import Transcription, Transcriber

SR = 16000


class RampedTranscriber(Transcriber):
    """Returns text depending on how much audio it has seen (like real whisper)."""

    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def transcribe(self, audio_pcm16: np.ndarray) -> Transcription:
        self.calls += 1
        # Simulate a model that first hears "hello world", then extends it.
        n = audio_pcm16.size
        if n < SR * 0.5:
            return Transcription(text="", is_final=False)
        if self.calls == 1:
            return Transcription(text="hello world", is_final=False)
        if self.calls == 2:
            return Transcription(text="hello world today", is_final=False)
        return Transcription(text="hello world today's meeting", is_final=False)


def make_cfg() -> Settings:
    cfg = Settings()
    cfg.chunk_threshold_seconds = 0.05
    cfg.sample_rate = SR
    cfg.max_between_runs_seconds = 0.2
    return cfg


def test_health_and_ready():
    app = create_app(transcriber=RampedTranscriber(), stt_settings=make_cfg())
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}
        ready = client.get("/ready").json()
        assert ready["status"] == "ok"


def test_ws_streaming_partial_then_final():
    app = create_app(transcriber=RampedTranscriber(), stt_settings=make_cfg())
    with TestClient(app) as client:
        with client.websocket_connect("/client/ws/speech") as ws:
            info = ws.receive_json()
            assert info["message"] == "info"

            # ~0.5s of audio -> first partial
            ws.send_bytes(np.zeros(SR // 2, dtype=np.int16).tobytes())
            msg = ws.receive_json()
            assert msg["message"] == "partial"
            assert msg["transcript"] == "hello world"

            # more audio -> partial for the extended tail
            ws.send_bytes(np.zeros(SR // 2, dtype=np.int16).tobytes())
            msg = ws.receive_json()
            assert msg["message"] == "partial"
            assert msg["transcript"] == "today"

            # final flush on disconnect
            ws.close()
            final = ws.receive_json()
            assert final["message"] == "final"


def test_ws_end_of_stream_flushes_final_while_socket_open():
    """Proxy sends end_of_stream before closing; tail must arrive as a final."""
    app = create_app(transcriber=RampedTranscriber(), stt_settings=make_cfg())
    with TestClient(app) as client:
        with client.websocket_connect("/client/ws/speech") as ws:
            info = ws.receive_json()
            assert info["message"] == "info"

            ws.send_bytes(np.zeros(SR // 2, dtype=np.int16).tobytes())
            msg = ws.receive_json()
            assert msg["message"] == "partial"

            # End-of-meeting handshake: flush + ack, still on an open socket.
            ws.send_text(json.dumps({"message": "end_of_stream"}))
            final = ws.receive_json()
            assert final["message"] == "final"
            # Second model call (first was the partial above).
            assert final["transcript"] == "hello world today"

            ack = ws.receive_json()
            assert ack["message"] == "end_of_stream_done"


def test_ws_end_of_stream_on_empty_buffer_still_acks():
    app = create_app(transcriber=RampedTranscriber(), stt_settings=make_cfg())
    with TestClient(app) as client:
        with client.websocket_connect("/client/ws/speech") as ws:
            assert ws.receive_json()["message"] == "info"
            ws.send_text(json.dumps({"message": "end_of_stream"}))
            ack = ws.receive_json()
            assert ack["message"] == "end_of_stream_done"


def test_ws_idle_timeout_does_not_crash_and_still_flushes():
    """Regression: idle path used to raise NameError on undefined logger,
    which skipped the final flush entirely."""
    cfg = make_cfg()
    cfg.idle_timeout_seconds = 0.2
    app = create_app(transcriber=RampedTranscriber(), stt_settings=cfg)
    with TestClient(app) as client:
        with client.websocket_connect("/client/ws/speech") as ws:
            assert ws.receive_json()["message"] == "info"
            # Leave the connection idle; the watchdog must fire cleanly.
            ws.send_bytes(np.zeros(SR // 2, dtype=np.int16).tobytes())
            # Drain the partial, then wait past the idle window.
            msg = ws.receive_json()
            assert msg["message"] == "partial"
            # Server flushes on idle timeout (socket still open) -> final.
            final = ws.receive_json()
            assert final["message"] == "final"


def test_ws_handles_silence_without_emitting():
    app = create_app(transcriber=RampedTranscriber(), stt_settings=make_cfg())
    with TestClient(app) as client:
        with client.websocket_connect("/client/ws/speech") as ws:
            info = ws.receive_json()
            assert info["message"] == "info"
            # tiny audio -> no transcript -> nothing emitted (receive would block,
            # so verify by sending a second chunk and only expecting one message)
            ws.send_bytes(np.zeros(100, dtype=np.int16).tobytes())
            ws.send_bytes(np.zeros(SR // 2, dtype=np.int16).tobytes())
            msg = ws.receive_json()
            assert msg["message"] == "partial"
            assert msg["transcript"] == "hello world"