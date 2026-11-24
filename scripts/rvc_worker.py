"""RVC の常駐ワーカー（このアプリ専用）。

- 起動時にモデルをロードしてウォームアップする（rvc_python の初回推論は 22.7 秒かかる）
- `POST /convert` は base64 WAV を受けて base64 WAV を返す（同期・直列）
- 変換条件（`index_rate` / `pitch` / `f0_method` / `protect`）は**リクエストで受け取る**。
  このファイルに既定値を埋め込まない（真実源は `config/settings.toml` の `[tts.voice_conversion]`）
- 出力は RVC ネイティブの 40kHz WAV。16kHz/16bit/mono への変換はアプリ側
  （`VoiceConversionService`）が行う

起動: `scripts\\start-rvc-worker.bat`（`RVCMultilingual\\venv` の python を使う）。
"""

from __future__ import annotations

import base64
import logging
import math
import os
import struct
import tempfile
import threading
from contextlib import contextmanager
from typing import Any

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("rvc_worker")

# pip 版 rvc_python は torch.load(weights_only=False) を要求する（環境変数だけに頼らない）
@contextmanager
def _patch_torch_load():
    original_load = torch.load

    def _safe_load(*args: Any, **kwargs: Any) -> Any:
        kwargs["weights_only"] = False
        return original_load(*args, **kwargs)

    torch.load = _safe_load
    try:
        yield
    finally:
        torch.load = original_load


def _tone_wav(seconds: float = 1.0, sample_rate: int = 16000, freq: float = 220.0) -> bytes:
    """ウォームアップ用のサイン波 WAV（無音だと F0 検出で落ちることがある）。"""
    frames = int(seconds * sample_rate)
    samples = bytearray()
    for i in range(frames):
        value = int(12000 * math.sin(2.0 * math.pi * freq * i / sample_rate))
        samples += struct.pack("<h", value)
    data = bytes(samples)
    header = (
        b"RIFF"
        + struct.pack("<I", 36 + len(data))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(data))
    )
    return header + data


class RvcWorker:
    """RVCInference を 1 つ保持し、モデルのロードと推論だけを行う。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rvc: Any = None
        self._model = ""
        self._index = ""
        self._warm = False
        self._device = os.environ.get("RVC_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")

    def status(self) -> dict[str, Any]:
        return {
            "warm": self._warm,
            "model": self._model,
            "index": self._index,
            "device": self._device,
        }

    @staticmethod
    def _normalize_path(path: str) -> str:
        """`/` と `\\` の違いで「モデルが変わった」と誤判定しないように正規化する。"""
        return os.path.normcase(os.path.realpath(path)) if path else ""

    def _ensure_model(self, model: str, index: str) -> None:
        if self._rvc is None:
            from rvc_python.infer import RVCInference

            logger.info("RVCInference を初期化します（device=%s）", self._device)
            self._rvc = RVCInference(device=self._device)
        if not model:
            raise ValueError("model が未指定です（tts.voice_conversion.model_path）")
        same = self._normalize_path(model) == self._normalize_path(
            self._model
        ) and self._normalize_path(index) == self._normalize_path(self._index)
        if same:
            return
        with _patch_torch_load():
            logger.info("モデルを読み込みます: %s（index=%s）", model, index or "なし")
            self._rvc.load_model(model, index_path=index or "")
        self._model = model
        self._index = index
        self._warm = False

    def load(self, model: str, index: str) -> None:
        with self._lock:
            self._ensure_model(model, index)

    def warmup(self, model: str, index: str) -> None:
        """1 回推論して HuBERT/RMVPE の遅延ロードを済ませる。"""
        with self._lock:
            self._ensure_model(model, index)
            if self._warm:
                return
            with tempfile.TemporaryDirectory(prefix="rvc-warm-") as tmp:
                src = os.path.join(tmp, "in.wav")
                dst = os.path.join(tmp, "out.wav")
                with open(src, "wb") as handle:
                    handle.write(_tone_wav())
                self._rvc.set_params(f0up_key=0, f0method="rmvpe", index_rate=0.0, protect=0.33)
                with _patch_torch_load():
                    self._rvc.infer_file(input_path=src, output_path=dst)
            self._warm = True
            logger.info("ウォームアップ完了（model=%s）", self._model)

    def convert(
        self,
        wav_bytes: bytes,
        *,
        model: str,
        index: str,
        pitch: int,
        f0_method: str,
        index_rate: float,
        protect: float,
    ) -> bytes:
        with self._lock:
            self._ensure_model(model, index)
            with tempfile.TemporaryDirectory(prefix="rvc-") as tmp:
                src = os.path.join(tmp, "in.wav")
                dst = os.path.join(tmp, "out.wav")
                with open(src, "wb") as handle:
                    handle.write(wav_bytes)
                # 変換条件はすべて呼び出し側（settings.toml）から来る値を使う
                self._rvc.set_params(
                    f0up_key=int(pitch),
                    f0method=f0_method,
                    index_rate=float(index_rate),
                    protect=float(protect),
                )
                with _patch_torch_load():
                    self._rvc.infer_file(input_path=src, output_path=dst)
                if not os.path.exists(dst):
                    raise RuntimeError("RVC が出力を生成しませんでした")
                # 推論を 1 回通せば内部の遅延ロードは済んでいる
                self._warm = True
                with open(dst, "rb") as handle:
                    return handle.read()


app = FastAPI(title="rvc-worker")
worker = RvcWorker()


class ModelRequest(BaseModel):
    model: str
    index: str = ""


class ConvertRequest(BaseModel):
    """変換条件はすべてリクエストで受け取る（このファイルに既定値を埋め込まない）。"""

    wav_base64: str
    model: str = ""
    index: str = ""
    pitch: int = 0
    f0_method: str = "rmvpe"
    index_rate: float = 0.0
    protect: float = 0.33


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, **worker.status()}


@app.post("/model")
def select_model(req: ModelRequest) -> dict[str, Any]:
    try:
        worker.load(req.model, req.index)
    except Exception as exc:  # noqa: BLE001 - 原因をそのまま返す
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"ok": True, **worker.status()}


@app.post("/convert")
def convert(req: ConvertRequest) -> dict[str, str]:
    try:
        wav_bytes = base64.b64decode(req.wav_base64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"wav_base64 を復号できません: {exc}") from exc
    try:
        out = worker.convert(
            wav_bytes,
            model=req.model,
            index=req.index,
            pitch=req.pitch,
            f0_method=req.f0_method,
            index_rate=req.index_rate,
            protect=req.protect,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("変換に失敗しました")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"wav_base64": base64.b64encode(out).decode("ascii")}


def _warmup_from_env() -> None:
    model = os.environ.get("RVC_WARMUP_MODEL", "").strip()
    if not model:
        logger.info("RVC_WARMUP_MODEL が未設定のためウォームアップを省略します")
        return
    index = os.environ.get("RVC_WARMUP_INDEX", "").strip()
    try:
        worker.warmup(model, index)
    except Exception:  # noqa: BLE001 - 起動は続ける（初回変換で再試行される）
        logger.exception("ウォームアップに失敗しました（起動は継続します）")


def main() -> None:
    import uvicorn

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s"
    )
    _warmup_from_env()
    port = int(os.environ.get("RVC_PORT", "9890"))
    logger.info("RVC ワーカーを http://127.0.0.1:%d で起動します", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
