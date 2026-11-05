"""Text-to-speech helpers for local Windows SAPI or Hugging Face Chatterbox."""

# START doc_example

import argparse
import os
import time
import tempfile

from gradio_client import Client, handle_file

from reachy_mini import ReachyMini  # noqa: E402

HF_SPACE = "ResembleAI/Chatterbox-Multilingual-TTS"
LANGUAGES = [
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it",
    "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
]
DEFAULT_REF_AUDIO = (
    "https://github.com/gradio-app/gradio/raw/main/test/test_files/audio_sample.wav"
)

# Convert text to an audio file
def synthesize(text: str, lang: str, ref_audio: str) -> str:
    """Submit text to the Hugging Face service and return its local WAV path."""
    if not ref_audio.startswith(("http://", "https://")):
        ref_audio = os.path.expanduser(ref_audio)
    client = Client(HF_SPACE)
    audio_path = client.predict(
        text_input=text,
        language_id=lang,
        audio_prompt_path_input=handle_file(ref_audio),
        api_name="/generate_tts_audio",
    )
    return str(audio_path)


def synthesize_local(text: str) -> str:
    """Generate a WAV with the Windows offline SAPI voice."""
    try:
        import pyttsx3
    except ImportError as exc:
        raise RuntimeError(
            "Offline TTS requires pyttsx3. Install it with "
            "`python -m pip install pyttsx3` in the active Python environment."
        ) from exc

    # Use a fixed file per process so repeated requests replace stale audio safely.
    output_path = os.path.join(
        tempfile.gettempdir(),
        f"reachy_tts_{abs(hash(text))}.wav",
    )
    engine = pyttsx3.init()
    engine.setProperty("rate", 175)
    engine.save_to_file(text, output_path)
    engine.runAndWait()
    if not os.path.isfile(output_path):
        raise RuntimeError("pyttsx3 did not create the requested WAV file.")
    return output_path


def probe_duration_s(text: str) -> float:
    # Approximate playback time while the remote audio file format is not inspected.
    """Estimate speaking time from the number of words."""
    word_count = len(text.split())
    return max(1.0, word_count / 2.5 + 0.5)


def speak(
    text: str,
    lang: str,
    ref_audio: str,
    mini: ReachyMini | None = None,
    provider: str = "huggingface",
) -> None:
    """Synthesize *text*, play it on Reachy Mini with wobbling enabled."""
    if provider == "local":
        print(f"Synthesizing {len(text)} chars with local Windows TTS...")
        audio_path = synthesize_local(text)
    else:
        print(f"Synthesizing {len(text)} chars ({lang}) with Chatterbox...")
        audio_path = synthesize(text, lang, ref_audio)
    duration = probe_duration_s(text)
    print(f"Got {audio_path} ({duration:.1f}s)")

    owns_mini = mini is None
    if mini is None:
        mini = ReachyMini(log_level="INFO")
        mini.__enter__()

    try:
        mini.media.play_sound(audio_path)
        time.sleep(duration + 0.5)
    finally:
        if owns_mini:
            mini.__exit__(None, None, None)
    print("Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Chatterbox Multilingual TTS + head wobbler demo.",
    )
    parser.add_argument(
        "--text",
        type=str,
        default="Hello, I am Reachy Mini. Let me wobble my head while I speak.",
        help="Text to synthesize (max 300 chars per request).",
    )
    parser.add_argument(
        "--lang",
        type=str,
        default="en",
        choices=LANGUAGES,
        help="Language code (ISO 639-1).",
    )
    parser.add_argument(
        "--ref-audio",
        type=str,
        default=DEFAULT_REF_AUDIO,
        help="Reference audio (URL or local path) for zero-shot voice cloning.",
    )
    args = parser.parse_args()
    speak(
        text=args.text,
        lang=args.lang,
        ref_audio=args.ref_audio,
    )

# END doc_example