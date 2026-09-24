"""One resident model process. Its whole process group owns a single job.

The HTTP supervisor can stop FFmpeg *and* inference, rather than abandon a
Python thread that still owns the GPU. Normal jobs reuse the loaded model.
"""
import asyncio
import logging
import math
import multiprocessing
import os
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

JOB_TIMEOUT_SECONDS = 240
DOWNLOAD_TIMEOUT_SECONDS = 60
READ_TIMEOUT_SECONDS = 15
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
SETTLED_HEADERS = {"X-Whisper-Job-Settled": "true"}
logger = logging.getLogger(__name__)


class JobError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def process_group_active(group):
    # Reaping the model's PID does not prove its FFmpeg children have exited.
    # Zombies have already released their files and cannot perform more work.
    if os.path.isdir('/proc'):
        for entry in os.scandir('/proc'):
            if not entry.name.isdigit():
                continue
            try:
                with open(os.path.join(entry.path, 'stat')) as file:
                    fields = file.read().rsplit(')', 1)[1].split()
                if int(fields[2]) == group and fields[0] not in ('Z', 'X'):
                    return True
            except (FileNotFoundError, ProcessLookupError):
                continue
        return False
    # macOS development/test hosts have no procfs.
    rows = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True)
    return any(int(fields[0]) == group and not fields[1].startswith(('Z', 'X'))
               for line in rows.splitlines() if (fields := line.split()))


def download_source(source, directory):
    if not source.startswith(("http://", "https://")):
        return source  # Preserve local-file inputs used by operator canaries.
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
    target = os.path.join(directory, "input")
    try:
        with urllib.request.urlopen(source, timeout=READ_TIMEOUT_SECONDS) as response:
            size = 0
            with open(target, "wb") as output:
                while True:
                    if time.monotonic() >= deadline:
                        raise JobError(504, "Source download timed out")
                    data = response.read1(64 * 1024)
                    if not data:
                        break
                    size += len(data)
                    if size > MAX_DOWNLOAD_BYTES:
                        raise JobError(413, "Source exceeds the download size limit")
                    output.write(data)
    except urllib.error.HTTPError as error:
        raise JobError(422, f"Source download failed (HTTP {error.code})") from None
    except (TimeoutError, urllib.error.URLError):
        raise JobError(504, "Source download failed or timed out") from None
    return target


def transcribe(model, params, directory, progress=lambda phase: None):
    from whisper.utils import get_writer

    progress("download")
    source = download_source(params["fileurl"], directory)
    progress("transcribe")
    word_timestamps = str(params.get("word_timestamps", "True")).lower() != "false"
    options = {"hallucination_silence_threshold": 1.0}
    if params.get("language"):
        options["language"] = params["language"]
    result = model.transcribe(source, word_timestamps=word_timestamps, **options)
    writer_args = {
        "highlight_words": str(params.get("highlight_words", "False")).lower() == "true",
        "max_line_count": None,
        "max_line_width": None,
        "max_words_per_line": None,
    }
    for key in ("max_line_count", "max_line_width", "max_words_per_line"):
        if key in params:
            writer_args[key] = int(params[key])
    formatting_keys = {"language", "highlight_words", "max_line_count", "max_line_width", "max_words_per_line"}
    if word_timestamps and not formatting_keys.intersection(params):
        writer_args["max_words_per_line"] = 1
    output = os.path.join(directory, "result.srt")
    get_writer("srt", directory)(result, output, writer_args)
    with open(output) as file:
        return file.read()


def serve(connection):
    os.setsid()
    try:
        import whisper
        model = whisper.load_model("turbo", download_root="./models")
        connection.send((200, "ready"))
        while True:
            params, directory = connection.recv()
            try:
                connection.send((200, transcribe(model, params, directory, lambda phase: connection.send(("phase", phase)))))
            except JobError as error:
                connection.send((error.status, str(error)))
            except Exception as error:
                # Exception text from FFmpeg can contain the signed source URL.
                logger.error("Transcription failed: %s", type(error).__name__)
                connection.send((503, "Unable to decode or transcribe the media"))
    except EOFError:
        pass
    except Exception as error:
        logger.error("Model worker failed: %s", type(error).__name__)
    finally:
        connection.close()


class ModelWorker:
    def __init__(self, target=serve, timeout=JOB_TIMEOUT_SECONDS, startup_timeout=180, download_timeout=DOWNLOAD_TIMEOUT_SECONDS):
        self.target = target
        self.timeout = timeout
        self.startup_timeout = startup_timeout
        self.download_timeout = download_timeout
        self.process = None
        self.connection = None
        self.ready = False
        self.busy = False
        self.recovery = None

    async def start(self):
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=self.target, args=(child,), daemon=True)
        self.process.start()
        child.close()
        deadline = time.monotonic() + self.startup_timeout
        try:
            while not self.connection.poll():
                if not self.process.is_alive() or time.monotonic() >= deadline:
                    raise JobError(503, "Model worker could not start")
                await asyncio.sleep(0.05)
            if self.connection.recv() != (200, "ready"):
                raise JobError(503, "Model worker could not start")
            self.ready = True
        except BaseException:
            await self.stop()
            raise

    async def stop(self):
        self.ready = False
        process = self.process
        if process is not None:
            # Always kill the group, even if its leader already exited: FFmpeg
            # may still be running. The fallback covers cancellation before setsid.
            for sig, grace in ((signal.SIGTERM, 0.25), (signal.SIGKILL, 2)):
                try:
                    os.killpg(process.pid, sig)
                except ProcessLookupError:
                    if process.is_alive():
                        os.kill(process.pid, sig)
                await asyncio.to_thread(process.join, grace)
            deadline = time.monotonic() + 2
            while process_group_active(process.pid) and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            if process.is_alive() or process_group_active(process.pid):
                raise JobError(503, "Model worker did not stop")
            process.close()
            self.process = None
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    async def recover(self):
        try:
            await self.start()
        except Exception:
            logger.error("Model recovery failed; worker remains unavailable")

    async def close(self):
        if self.recovery:
            self.recovery.cancel()
            await asyncio.gather(self.recovery, return_exceptions=True)
        await self.stop()

    async def run(self, params, disconnected):
        if self.busy or not self.ready:
            raise JobError(429, "Worker busy; no job accepted")
        self.busy = True
        directory = None
        stopped = True
        try:
            try:
                directory = tempfile.mkdtemp(prefix="whisper-")
            except OSError:
                raise JobError(503, "Unable to allocate temporary media storage") from None
            remaining = self.timeout
            if "deadline" in params:
                try:
                    declared = float(params["deadline"])
                    if not math.isfinite(declared):
                        raise ValueError()
                    remaining = min(remaining, declared - time.time())
                except (TypeError, ValueError):
                    raise JobError(400, "Invalid job deadline") from None
            if not 0 < remaining <= self.timeout:
                raise JobError(408, "Job deadline expired")
            deadline = time.monotonic() + remaining
            phase_deadline = deadline
            stopped = False
            self.connection.send((params, directory))
            while True:
                if await disconnected():
                    raise JobError(499, "Transcription cancelled")
                if time.monotonic() >= min(deadline, phase_deadline):
                    raise JobError(504, "Transcription deadline exceeded")
                if not self.process.is_alive():
                    raise JobError(503, "Model worker exited")
                if self.connection.poll():
                    status, result = self.connection.recv()
                    if status == "phase":
                        phase_deadline = time.monotonic() + self.download_timeout if result == "download" else deadline
                        continue
                    if status != 200:
                        # The child has finished using its inputs before this ack.
                        # An unexpected inference failure may leave CUDA in a
                        # bad state. Recreate that model before accepting work.
                        stopped = status != 503
                        raise JobError(status, result)
                    stopped = True
                    return result
                await asyncio.sleep(0.05)
        finally:
            if not stopped:
                await self.stop()
                self.recovery = asyncio.create_task(self.recover())
            # Never delete files or admit the next job while a child still uses them.
            if directory:
                try:
                    shutil.rmtree(directory)
                except OSError:
                    logger.error("Unable to remove completed job's temporary files")
            self.busy = False
