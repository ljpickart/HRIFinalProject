"""Capture audio from Reachy and detect when a user starts and stops speaking."""

import time

import numpy as np

from robot import connect

RECORD_SECONDS = 5.0
END_SPEECH_SECONDS = 1.0
DEFAULT_VAD_THRESHOLD = 0.02
WHISPER_SAMPLE_RATE = 16_000


def _as_mono(audio: np.ndarray) -> np.ndarray:
    """Convert mono or multi-channel audio to a one-dimensional float array."""
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        return np.mean(audio, axis=1).astype(np.float32)
    if audio.ndim == 1:
        return audio
    raise ValueError(f"Unexpected audio shape: {audio.shape}")


def speech_rms(audio: np.ndarray) -> float:
    """Return the root-mean-square volume for one audio chunk."""
    mono = _as_mono(audio)
    if mono.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(mono))))


def record(mini, seconds: float) -> np.ndarray:
    """Pull float32 audio chunks for a fixed amount of time."""
    mini.media.start_recording()
    print(f"Recording for up to {seconds:.1f} s. Speak into the robot...")

    chunks: list[np.ndarray] = []
    t0 = time.time()
    try:
        while time.time() - t0 < seconds:
            sample = mini.media.get_audio_sample()
            if sample is not None:
                chunks.append(sample)
            else:
                time.sleep(0.01)
    except KeyboardInterrupt:
        print("\nRecording stopped early.")
    finally:
        mini.media.stop_recording()

    if not chunks:
        raise RuntimeError(
            "No mic samples received. Is the daemon running, and is "
            "media free (close the conversation app if it is open)?"
        )

    audio = np.concatenate(chunks, axis=0).astype(np.float32)
    sr = mini.media.get_input_audio_samplerate()
    print(f"Captured {audio.shape[0] / sr:.2f} s, shape={audio.shape}, sr={sr}")
    return audio


def record_response(
    mini,
    vad_threshold: float = DEFAULT_VAD_THRESHOLD,
    timeout_seconds: float = 15.0,
    end_speech_seconds: float = END_SPEECH_SECONDS,
) -> np.ndarray:
    """Wait for speech, record it, and stop after a period of silence."""
    mini.media.start_recording()
    chunks: list[np.ndarray] = []
    speech_started = False
    silent_seconds = 0.0
    started_at = time.monotonic()
    last_time = started_at

    print("Listening for a response...")
    try:
        while time.monotonic() - started_at < timeout_seconds:
            now = time.monotonic()
            elapsed = now - last_time
            last_time = now
            chunk = mini.media.get_audio_sample()

            if chunk is None:
                time.sleep(0.01)
                continue

            chunk_mono = _as_mono(chunk)
            chunks.append(chunk_mono)
            is_speaking = speech_rms(chunk_mono) > vad_threshold

            if is_speaking:
                if not speech_started:
                    print("Speech detected.")
                speech_started = True
                silent_seconds = 0.0
            elif speech_started:
                silent_seconds += elapsed
                if silent_seconds >= end_speech_seconds:
                    print("End of speech detected.")
                    break

        if not speech_started:
            raise RuntimeError(
                "No speech detected before the timeout. Check the robot microphone."
            )
    except KeyboardInterrupt:
        print("\nRecording stopped by the user.")
    finally:
        mini.media.stop_recording()

    audio = np.concatenate(chunks, axis=0).astype(np.float32)
    return audio


def transcribe(
    audio: np.ndarray,
    sample_rate: int = WHISPER_SAMPLE_RATE,
    language: str = "en",
) -> str:
    """Convert robot microphone samples to text with faster-whisper."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "Speech recognition requires faster-whisper. Install it in the "
            "active environment with: python -m pip install faster-whisper"
        ) from exc

    # Faster-whisper expects 16 kHz mono PCM. Robot recording values may
    # arrive at another rate, so resample without requiring scipy.
    source_rate = sample_rate
    if source_rate != WHISPER_SAMPLE_RATE:
        source_positions = np.arange(audio.size, dtype=np.float32)
        target_positions = np.linspace(
            0,
            audio.size - 1,
            round(audio.size * WHISPER_SAMPLE_RATE / source_rate),
            dtype=np.float32,
        )
        audio = np.interp(target_positions, source_positions, audio).astype(np.float32)

    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio, language=language)
    return " ".join(segment.text.strip() for segment in segments).strip()


def play(mini, audio: np.ndarray) -> None:
    """Push PCM to the robot speaker. Non-blocking; we sleep for the duration."""
    # → In a real app, generate TTS here and push small (~20 ms) chunks
    #   as they arrive instead of waiting for the full clip.
    sr = mini.media.get_output_audio_samplerate()
    mini.media.start_playing()
    print("Playing back on the robot speaker...")
    mini.media.push_audio_sample(audio)
    time.sleep(len(audio) / sr)
    mini.media.stop_playing()


def main() -> None:
    with connect(media_backend="default") as mini:
        # → ASR would consume these chunks in a streaming loop.
        audio = record(mini, RECORD_SECONDS)
        # → Your dialogue / LLM logic goes here.
        play(mini, audio)

    print("Done.")


if __name__ == "__main__":
    main()
