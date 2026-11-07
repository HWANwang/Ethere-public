"""Small CPU-only audio worker. JSON lines in/out; no user audio is written to disk."""

import base64
import io
import json
import os
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ASR_NAME = "sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16"
ASR_DIR = ROOT / "models" / "asr" / ASR_NAME

_recognizer = None


def get_recognizer():
    global _recognizer
    if _recognizer is None:
        import sherpa_onnx

        paths = {
            "tokens": ASR_DIR / "tokens.txt",
            "encoder": ASR_DIR / "encoder-epoch-99-avg-1.int8.onnx",
            "decoder": ASR_DIR / "decoder-epoch-99-avg-1.onnx",
            "joiner": ASR_DIR / "joiner-epoch-99-avg-1.int8.onnx",
        }
        if any(not path.is_file() for path in paths.values()):
            raise RuntimeError("本地识别模型尚未安装")
        _recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            **{name: str(path) for name, path in paths.items()},
            num_threads=2,
            decoding_method="greedy_search",
        )
    return _recognizer


def transcribe(audio_b64):
    import numpy as np

    raw = base64.b64decode(audio_b64, validate=True)
    if len(raw) > 8_000_000:
        raise ValueError("录音超过大小限制")
    with wave.open(io.BytesIO(raw), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("只接受单声道 16-bit WAV")
        sample_rate = wav.getframerate()
        if sample_rate != 16000:
            raise ValueError("录音采样率须为 16 kHz")
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if samples.size < 1600:
        raise ValueError("录音太短")
    recognizer = get_recognizer()
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    stream.accept_waveform(sample_rate, np.zeros(int(0.6 * sample_rate), dtype=np.float32))
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    result = recognizer.get_result(stream)
    return (result if isinstance(result, str) else result.text).strip()


def main():
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            started = time.monotonic()
            if request.get("op") == "asr":
                result = {"text": transcribe(request["audioBase64"])}
            else:
                raise ValueError("未知操作")
            result.update({"id": request.get("id"), "ok": True, "elapsedMs": round((time.monotonic() - started) * 1000)})
        except Exception as exc:
            result = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(exc)[:300]}
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

