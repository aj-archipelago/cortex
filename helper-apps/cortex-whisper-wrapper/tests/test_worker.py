import asyncio
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from worker import ModelWorker, JobError


def fake_worker(connection):
    os.setsid()
    connection.send((200, "ready"))
    while True:
        params, directory = connection.recv()
        mode = params.get("mode")
        if mode in ("hang", "download"):
            child = subprocess.Popen([sys.executable, "-c", "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(120)"])
            Path(params["pid_file"]).write_text(str(child.pid))
            if mode == "download":
                connection.send(("phase", "download"))
            time.sleep(120)
        elif mode == "fail":
            connection.send((422, "Source download failed (HTTP 404)"))
        elif mode == "inference_fail":
            connection.send((503, "Unable to decode or transcribe the media"))
        elif mode == "crash":
            os._exit(1)
        else:
            Path(directory, "input").write_text("media")
            connection.send((200, directory))


async def connected():
    return False


def alive(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return bool(result.stdout.strip()) and not result.stdout.strip().startswith("Z")


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.worker = ModelWorker(target=fake_worker, timeout=0.6, startup_timeout=10, download_timeout=0.2)
        await self.worker.start()

    async def asyncTearDown(self):
        await self.worker.close()

    async def test_success_reuses_model_and_cleans_input(self):
        pid = self.worker.process.pid
        for _ in range(2):
            directory = await self.worker.run({}, connected)
            self.assertFalse(Path(directory).exists())
            self.assertEqual(pid, self.worker.process.pid)
        self.assertFalse(self.worker.busy)

    async def test_source_failure_is_terminal_and_releases_worker(self):
        pid = self.worker.process.pid
        with self.assertRaises(JobError) as failure:
            await self.worker.run({"mode": "fail"}, connected)
        self.assertEqual(failure.exception.status, 422)
        self.assertEqual(pid, self.worker.process.pid)
        await self.worker.run({}, connected)

    async def test_expired_or_invalid_deadline_does_not_restart_model(self):
        pid = self.worker.process.pid
        for deadline in (time.time() - 1, "bad", float("nan"), float("inf")):
            with self.assertRaises(JobError):
                await self.worker.run({"deadline": deadline}, connected)
            self.assertEqual(pid, self.worker.process.pid)
            self.assertFalse(self.worker.busy)

    async def test_crash_or_inference_failure_restarts_model(self):
        for mode in ("crash", "inference_fail"):
            old_pid = self.worker.process.pid
            with self.assertRaises(JobError) as failure:
                await self.worker.run({"mode": mode}, connected)
            self.assertEqual(failure.exception.status, 503)
            await self.worker.recovery
            self.assertNotEqual(self.worker.process.pid, old_pid)
            await self.worker.run({}, connected)

    async def test_temp_storage_failure_does_not_leave_worker_busy(self):
        with patch("worker.tempfile.mkdtemp", side_effect=OSError("disk full")):
            with self.assertRaises(JobError):
                await self.worker.run({}, connected)
        self.assertFalse(self.worker.busy)
        await self.worker.run({}, connected)

    async def assert_stopped(self, mode, cancel=False):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory, "pid")
            disconnected = asyncio.Event()
            async def check_disconnect():
                return disconnected.is_set()
            old_pid = self.worker.process.pid
            task = asyncio.create_task(self.worker.run({"mode": mode, "pid_file": str(marker)}, check_disconnect))
            limit = time.monotonic() + 5
            while not marker.exists():
                self.assertLess(time.monotonic(), limit)
                await asyncio.sleep(0.01)
            # A busy worker rejects another job instead of queueing it.
            with self.assertRaises(JobError) as busy:
                await self.worker.run({}, connected)
            self.assertEqual(busy.exception.status, 429)
            if cancel:
                disconnected.set()
            with self.assertRaises(JobError) as failure:
                await task
            self.assertEqual(failure.exception.status, 499 if cancel else 504)
            grandchild = int(marker.read_text())
            self.assertFalse(alive(grandchild), "FFmpeg-like child survived cancellation")
            self.assertFalse(alive(old_pid))
            await self.worker.recovery
            await self.worker.run({}, connected)

    async def test_deadline_kills_process_group_and_next_job_succeeds(self):
        await self.assert_stopped("hang")

    async def test_disconnect_kills_process_group_and_next_job_succeeds(self):
        await self.assert_stopped("hang", cancel=True)

    async def test_download_has_its_own_shorter_deadline(self):
        self.worker.timeout = 30
        started = time.monotonic()
        await self.assert_stopped("download")
        self.assertLess(time.monotonic() - started, 5)


if __name__ == "__main__":
    unittest.main()
