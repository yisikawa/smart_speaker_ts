"""Qwen3-TTS 0.6B-Base で「日英が同じ声になるか」を実測する検証スクリプト（B 案のスパイク）。

`docs/TTS_MULTILINGUAL.md` の 2-C / 3 章に対応する。TTS サーバーは不要で、
参照音声から ja / en を直接合成して RTF・VRAM・話者類似度を測る。

前提:
  - `.venv-tts`（`python -m venv .venv-tts --system-site-packages` + `pip install qwen-tts`）
  - 参照音声（1〜10 秒）。権利が確認できる音声を使うこと（例: Windows 内蔵音声の出力）

使い方:
  .venv-tts\\Scripts\\python.exe scripts\\spike-qwen-tts.py --ref logs\\tts-spike\\ref_ja.wav ^
      --ref-text "こんにちは。私は音声アシスタントです。今日も元気に会話しましょう。"

出力:
  logs/tts-spike/qwen-ja-*.wav / qwen-en-*.wav（16kHz 16bit モノラル）

注意:
  - 話者類似度は MFCC 平均のコサイン類似度（簡易指標）。0.9 以上なら「同じ声」の目安
  - `--model` で 1.7B も試せるが RTX 3060 12GB では 0.6B を推奨
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Qwen3-TTS の日英同一話者を実測する")
    parser.add_argument("--ref", required=True, help="参照音声（wav）")
    parser.add_argument("--ref-text", default="", help="参照音声の書き起こし（ICL モードで使う）")
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-Base")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--dtype", choices=["bf16", "fp16"], default="bf16")
    parser.add_argument(
        "--attn",
        default="sdpa",
        help="attention 実装（sdpa | eager | flash_attention_2）。flash-attn は Windows では未ビルドが普通",
    )
    parser.add_argument(
        "--compile",
        action="store_true",
        help="torch.compile を試す（初回に数十秒かかる）",
    )
    parser.add_argument("--out-dir", default="logs/tts-spike")
    parser.add_argument("--ja-text", default="こんにちは。今日はいい天気ですね。一緒に散歩しませんか。")
    parser.add_argument(
        "--en-text", default="Hello. The weather is nice today. Shall we take a walk together?"
    )
    return parser.parse_args()


def resample_to_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    """16kHz モノラルへ変換する（このアプリの口パク・VAD の前提に合わせる）。"""
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
    """MFCC 平均ベクトルのコサイン類似度（簡易な話者類似度）。"""
    import librosa

    def vec(x: np.ndarray) -> np.ndarray:
        m = librosa.feature.mfcc(y=x.astype(np.float32), sr=16000, n_mfcc=20)
        return m.mean(axis=1)

    va, vb = vec(a), vec(b)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    return float(np.dot(va, vb) / denom) if denom else 0.0


def f0_stats(a: np.ndarray) -> tuple[float, float]:
    """F0 の中央値と四分位範囲（話者の高さの目安）。"""
    import librosa

    f0 = librosa.yin(a.astype(np.float32), fmin=70, fmax=500, sr=16000)
    voiced = f0[np.isfinite(f0) & (f0 > 0)]
    if voiced.size == 0:
        return 0.0, 0.0
    return float(np.median(voiced)), float(np.percentile(voiced, 75) - np.percentile(voiced, 25))


def vram_mib() -> tuple[int, int]:
    import torch

    if not torch.cuda.is_available():
        return 0, 0
    return (
        int(torch.cuda.memory_allocated() / (1024 * 1024)),
        int(torch.cuda.max_memory_allocated() / (1024 * 1024)),
    )


def main() -> int:
    args = parse_args()
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    out_dir = Path(args.out_dir)
    print(f"=== Qwen3-TTS spike ===\nmodel: {args.model}\nref  : {args.ref}")

    ref_audio, ref_sr = sf.read(args.ref, dtype="float32")
    if ref_audio.ndim > 1:
        ref_audio = ref_audio.mean(axis=1)
    print(f"ref 長: {len(ref_audio) / ref_sr:.2f}s / {ref_sr}Hz")

    languages = getattr(Qwen3TTSModel, "get_supported_languages", None)
    if callable(languages):
        try:
            print(f"対応言語: {languages()}")
        except Exception as exc:  # モデル依存のため失敗しても続行する
            print(f"対応言語の取得に失敗: {exc}")

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        dtype = torch.float32
    else:
        dtype = torch.bfloat16 if args.dtype == "bf16" else torch.float16
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    print(f"device: {device} / dtype: {dtype} / attn: {args.attn}")

    load_kwargs: dict = {"device_map": device, "dtype": dtype}
    if args.attn:
        load_kwargs["attn_implementation"] = args.attn
    t0 = time.perf_counter()
    try:
        model = Qwen3TTSModel.from_pretrained(args.model, **load_kwargs)
    except TypeError as exc:
        if "attn_implementation" not in load_kwargs:
            raise
        print(f"attn_implementation 非対応 → 外して再試行: {exc}")
        load_kwargs.pop("attn_implementation")
        model = Qwen3TTSModel.from_pretrained(args.model, **load_kwargs)
    load_s = time.perf_counter() - t0
    print(f"モデルロード: {load_s:.2f}s / VRAM {vram_mib()[1]}MiB")

    if args.compile:
        inner = getattr(model, "model", None)
        if inner is None:
            print("torch.compile は対象を特定できないため省略")
        else:
            try:
                model.model = torch.compile(inner, mode="reduce-overhead")
                print("torch.compile を適用（初回生成に時間がかかる）")
            except Exception as exc:
                print(f"torch.compile 失敗（続行）: {exc}")


    ref_kwargs: dict = {"ref_audio": (ref_audio, ref_sr)}
    if args.ref_text:
        ref_kwargs["ref_text"] = args.ref_text
    else:
        ref_kwargs["x_vector_only_mode"] = True
        print("ref_text 未指定 → x_vector_only_mode（書き起こし不要・類似度は下がる）")

    results: list[dict] = []
    for lang, text, tag in (
        ("Japanese", args.ja_text, "ja"),
        ("English", args.en_text, "en"),
    ):
        # ウォームアップ（初回はカーネル生成などで遅いため計測から除く）
        try:
            model.generate_voice_clone(text="こんにちは。", language="Japanese", **ref_kwargs)
        except Exception as exc:
            print(f"ウォームアップ失敗（続行）: {exc}")

        times: list[float] = []
        durations: list[float] = []
        last_audio = None
        for i in range(args.runs):
            start = time.perf_counter()
            wavs, sr = model.generate_voice_clone(text=text, language=lang, **ref_kwargs)
            elapsed = time.perf_counter() - start
            audio = resample_to_16k(np.asarray(wavs[0]), sr)
            times.append(elapsed)
            durations.append(len(audio) / 16000)
            last_audio = audio
            path = out_dir / f"qwen-{tag}-{i + 1}.wav"
            write_wav16(path, audio)
            print(
                f"  {tag}#{i + 1} 合成 {elapsed * 1000:.0f}ms / 音声 {durations[-1] * 1000:.0f}ms "
                f"/ RTF {elapsed / max(durations[-1], 1e-6):.2f} / {path}"
            )
        results.append(
            {
                "lang": tag,
                "p50_s": float(np.median(times)),
                "p50_dur": float(np.median(durations)),
                "rtf": float(np.median(times) / max(np.median(durations), 1e-6)),
                "audio": last_audio,
            }
        )

    ref16 = resample_to_16k(ref_audio, ref_sr)
    print("\n=== 話者類似度（MFCC コサイン。1.0 に近いほど同じ声）===")
    print(f"  ref vs ja: {mfcc_similarity(ref16, results[0]['audio']):.3f}")
    print(f"  ref vs en: {mfcc_similarity(ref16, results[1]['audio']):.3f}")
    print(f"  ja  vs en: {mfcc_similarity(results[0]['audio'], results[1]['audio']):.3f}")

    print("\n=== F0 中央値 / IQR（話者の高さ）===")
    for name, audio in (("ref", ref16), ("ja", results[0]["audio"]), ("en", results[1]["audio"])):
        med, iqr = f0_stats(audio)
        print(f"  {name}: {med:.1f}Hz / IQR {iqr:.1f}")

    print("\n=== まとめ ===")
    for r in results:
        print(f"  {r['lang']}: p50 {r['p50_s'] * 1000:.0f}ms / RTF {r['rtf']:.2f}")
    allocated, peak = vram_mib()
    print(f"  VRAM: 現在 {allocated}MiB / ピーク {peak}MiB")
    print(f"  音声の出力先: {out_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


