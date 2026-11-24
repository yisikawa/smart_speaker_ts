"""GPT-SoVITS api_v2 で「日英が同じ声になるか」を実測する検証スクリプト（B 案のスパイク）。

`docs/TTS_MULTILINGUAL.md` の 2-B / 3 章に対応する。起動済みの `api_v2.py`（既定 :9880）へ
`/tts` を投げ、参照音声 1 本から ja / en を合成して RTF・話者類似度を測る。

前提:
  - `api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml` が起動している
  - 参照音声（3〜10 秒）とその書き起こし。権利が確認できる音声を使うこと

使い方:
  .\\.venv-gsv\\Scripts\\python.exe ..\\smart_speaker_ts\\scripts\\spike-gpt-sovits.py ^
      --ref logs\\tts-spike\\ref_ja.wav --prompt-text "こんにちは。私は音声アシスタントです。"

出力:
  logs/tts-spike/gsv-ja-*.wav / gsv-en-*.wav（16kHz 16bit モノラル）
"""

from __future__ import annotations

import argparse
import io
import time
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GPT-SoVITS の日英同一話者を実測する")
    parser.add_argument("--endpoint", default="http://127.0.0.1:9880")
    parser.add_argument("--ref", required=True, help="参照音声（wav）。サーバーから読める絶対パス推奨")
    parser.add_argument("--prompt-text", required=True, help="参照音声の書き起こし")
    parser.add_argument("--prompt-lang", default="ja", help="参照音声の言語（ja | en | zh）")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--out-dir", default="logs/tts-spike")
    parser.add_argument("--ja-text", default="こんにちは。今日はいい天気ですね。一緒に散歩しませんか。")
    parser.add_argument(
        "--en-text", default="Hello. The weather is nice today. Shall we take a walk together?"
    )
    return parser.parse_args()


def resample_to_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    import librosa

    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = audio.astype(np.float32)
    if sr != 16000:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    return audio


def write_wav16(path: Path, audio: np.ndarray) -> None:
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(audio, -1.0, 1.0)
    sf.write(str(path), (clipped * 32767.0).astype(np.int16), 16000, subtype="PCM_16")


def mfcc_similarity(a: np.ndarray, b: np.ndarray) -> float:
    import librosa

    def vec(x: np.ndarray) -> np.ndarray:
        m = librosa.feature.mfcc(y=x.astype(np.float32), sr=16000, n_mfcc=20)
        return m.mean(axis=1)

    va, vb = vec(a), vec(b)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    return float(np.dot(va, vb) / denom) if denom else 0.0


def f0_stats(a: np.ndarray) -> tuple[float, float]:
    import librosa

    f0 = librosa.yin(a.astype(np.float32), fmin=70, fmax=500, sr=16000)
    voiced = f0[np.isfinite(f0) & (f0 > 0)]
    if voiced.size == 0:
        return 0.0, 0.0
    return float(np.median(voiced)), float(np.percentile(voiced, 75) - np.percentile(voiced, 25))


def main() -> int:
    args = parse_args()
    import requests
    import soundfile as sf

    out_dir = Path(args.out_dir)
    ref_path = str(Path(args.ref).resolve())
    print(f"=== GPT-SoVITS spike ===\nendpoint: {args.endpoint}\nref     : {ref_path}")

    def synthesize(text: str, lang: str) -> tuple[np.ndarray, float]:
        payload = {
            "text": text,
            "text_lang": lang,
            "ref_audio_path": ref_path,
            "prompt_text": args.prompt_text,
            "prompt_lang": args.prompt_lang,
            "streaming_mode": False,
            "speed_factor": 1.0,
        }
        start = time.perf_counter()
        res = requests.post(f"{args.endpoint}/tts", json=payload, timeout=300)
        elapsed = time.perf_counter() - start
        res.raise_for_status()
        audio, sr = sf.read(io.BytesIO(res.content), dtype="float32")
        return resample_to_16k(audio, sr), elapsed

    # ウォームアップ（初回はモデルの warmup で遅いため計測から除く）
    try:
        synthesize("こんにちは。", "ja")
        print("ウォームアップ完了")
    except Exception as exc:
        print(f"ウォームアップ失敗: {exc}")
        return 1

    results: list[dict] = []
    for lang, text, tag in (
        ("ja", args.ja_text, "ja"),
        ("en", args.en_text, "en"),
    ):
        times: list[float] = []
        durations: list[float] = []
        last_audio = None
        for i in range(args.runs):
            audio, elapsed = synthesize(text, lang)
            dur = len(audio) / 16000
            times.append(elapsed)
            durations.append(dur)
            last_audio = audio
            path = out_dir / f"gsv-{tag}-{i + 1}.wav"
            write_wav16(path, audio)
            print(
                f"  {tag}#{i + 1} 合成 {elapsed * 1000:.0f}ms / 音声 {dur * 1000:.0f}ms "
                f"/ RTF {elapsed / max(dur, 1e-6):.2f} / {path}"
            )
        results.append(
            {
                "lang": tag,
                "p50_s": float(np.median(times)),
                "rtf": float(np.median(times) / max(np.median(durations), 1e-6)),
                "audio": last_audio,
            }
        )

    ref_audio, ref_sr = sf.read(ref_path, dtype="float32")
    ref16 = resample_to_16k(ref_audio, ref_sr)
    print("\n=== 話者類似度（MFCC コサイン。1.0 に近いほど同じ声）===")
    print(f"  ref vs ja: {mfcc_similarity(ref16, results[0]['audio']):.3f}")
    print(f"  ref vs en: {mfcc_similarity(ref16, results[1]['audio']):.3f}")
    print(f"  ja  vs en: {mfcc_similarity(results[0]['audio'], results[1]['audio']):.3f}")

    print("\n=== F0 中央値 / IQR ===")
    for name, audio in (("ref", ref16), ("ja", results[0]["audio"]), ("en", results[1]["audio"])):
        med, iqr = f0_stats(audio)
        print(f"  {name}: {med:.1f}Hz / IQR {iqr:.1f}")

    print("\n=== まとめ ===")
    for r in results:
        print(f"  {r['lang']}: p50 {r['p50_s'] * 1000:.0f}ms / RTF {r['rtf']:.2f}")
    print(f"  音声の出力先: {out_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

