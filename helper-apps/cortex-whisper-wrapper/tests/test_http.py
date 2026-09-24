"""Exercise the real HTTP contract and supervisor against controlled downloads."""
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
import app
from worker import ModelWorker, JobError, download_source


def downloader(connection):
    os.setsid()
    connection.send((200, "ready"))
    while True:
        params, directory = connection.recv()
        try:
            connection.send(("phase", "download"))
            source = download_source(params["fileurl"], directory)
            connection.send((200, Path(source).read_text()))
        except JobError as error:
            connection.send((error.status, str(error)))


class SourceHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/missing":
            self.send_error(404)
            return
        self.send_response(200)
        self.end_headers()
        if self.path == "/drip":
            try:
                while True:
                    self.wfile.write(b"x")
                    self.wfile.flush()
                    time.sleep(0.03)
            except (BrokenPipeError, ConnectionResetError):
                return
        self.wfile.write(b"transcript")


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = ThreadingHTTPServer(("127.0.0.1", 0), SourceHandler)
        cls.thread = threading.Thread(target=cls.source.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.source.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.source.shutdown()
        cls.source.server_close()
        cls.thread.join()

    def setUp(self):
        self.worker = ModelWorker(target=downloader, timeout=2, download_timeout=0.25)
        self.patcher = patch.object(app, "worker", self.worker)
        self.patcher.start()
        self.client = TestClient(app.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.patcher.stop()

    def assert_settled(self, response, status):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.headers.get("x-whisper-job-settled"), "true")

    def test_validation_and_busy_accept_no_work(self):
        for payload in ({}, [], {"fileurl": 123}):
            self.assert_settled(self.client.post("/", json=payload), 400)
        self.assert_settled(self.client.post("/", content="{"), 400)
        self.worker.busy = True
        response = self.client.post("/", json={"fileurl": self.url})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["retry-after"], "2")
        self.worker.busy = False

    def test_source_404_is_terminal_and_next_request_works(self):
        pid = self.worker.process.pid
        response = self.client.post("/", json={"fileurl": self.url + "/missing"})
        self.assert_settled(response, 422)
        self.assertIn("HTTP 404", response.json()["detail"])
        self.assertEqual(self.client.get("/", params={"fileurl": self.url}).json(), "transcript")
        self.assertEqual(self.worker.process.pid, pid)

    def test_dripping_download_stops_then_model_recovers(self):
        pid = self.worker.process.pid
        started = time.monotonic()
        self.assert_settled(self.client.post("/", json={"fileurl": self.url + "/drip"}), 504)
        self.assertLess(time.monotonic() - started, 3)
        limit = time.monotonic() + 10
        while self.client.get("/health").status_code != 200:
            self.assertLess(time.monotonic(), limit)
            time.sleep(0.02)
        self.assertNotEqual(self.worker.process.pid, pid)
        self.assertEqual(self.client.post("/", json={"fileurl": self.url}).json(), "transcript")

    def test_download_size_limit(self):
        with tempfile.TemporaryDirectory() as directory, patch("worker.MAX_DOWNLOAD_BYTES", 2):
            with self.assertRaises(JobError) as failure:
                download_source(self.url, directory)
            self.assertEqual(failure.exception.status, 413)
