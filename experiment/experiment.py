# Final-project dialog loop: Node greeting -> robot microphone -> ASR -> Node -> TTS.

import asyncio
import os

from textToSpeech import DEFAULT_REF_AUDIO, speak
from record import record_response, transcribe
from robot import connect
import websockets


SERVER_URL = os.getenv("REACHY_NODE_WS_URL", "ws://localhost:8080")
TTS_PROVIDER = os.getenv("REACHY_TTS_PROVIDER", "huggingface")


def websocket_text(message: str | bytes) -> str:
    # WebSocket libraries may return either text or UTF-8 bytes.
    if isinstance(message, bytes):
        return message.decode("utf-8")
    return message


async def main() -> None:
    # Keep both WebSocket and Reachy connections open for the full conversation.
    async with websockets.connect(SERVER_URL) as ws:
        with connect(media_backend="webrtc") as mini:
            speaking = asyncio.Event()
            server_messages = asyncio.Queue()
            send_lock = asyncio.Lock()
            input_rate = mini.media.get_input_audio_samplerate()

            # Receive replies independently so the server can send them while
            # the robot is still listening for the next user utterance.
            async def receive_messages() -> None:
                try:
                    async for message in ws:
                        await server_messages.put(websocket_text(message))
                finally:
                    await server_messages.put("")

            # Speak every server message and never synthesize local prompts.
            async def speak_messages() -> None:
                while True:
                    message = await server_messages.get()
                    if not message:
                        return
                    speaking.set()
                    try:
                        await asyncio.to_thread(
                            speak,
                            message,
                            "en",
                            DEFAULT_REF_AUDIO,
                            mini,
                            provider=TTS_PROVIDER,
                        )
                    finally:
                        speaking.clear()
                        server_messages.task_done()

            # Transcribe continuous microphone input and send every result.
            async def listen_and_send() -> None:
                while True:
                    while speaking.is_set():
                        await asyncio.sleep(0.05)

                    try:
                        audio = await asyncio.to_thread(record_response, mini)
                    except RuntimeError as exc:
                        print(exc)
                        await asyncio.sleep(0.1)
                        continue

                    text = await asyncio.to_thread(
                        transcribe,
                        audio,
                        input_rate,
                        "en",
                    )
                    # Do not send speech captured while the robot was playing a
                    # server message, since part of that recording may be echo.
                    if speaking.is_set():
                        continue
                    if not text:
                        print("No words were recognized; listening again.")
                        continue

                    text = text.strip()
                    if text:
                        print(f"You said: {text}")
                        async with send_lock:
                            await ws.send(text)

            tasks = [
                asyncio.create_task(receive_messages()),
                asyncio.create_task(speak_messages()),
                asyncio.create_task(listen_and_send()),
            ]
            try:
                await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
