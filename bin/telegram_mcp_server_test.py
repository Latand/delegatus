"""Offline regressions for the packaged entrypoint over an MCP stand-in."""

import asyncio
import os
from pathlib import Path
import runpy
import sys
import types
import unittest
from unittest.mock import patch


class FastMCP:
    def __init__(self):
        self._mcp_server = types.SimpleNamespace(name="telegram")
        # FastMCP binds call_tool when its constructor registers the handler.
        self.dispatch = self.call_tool
        self.active = 0
        self.peak = 0
        self.entered = []
        self.release = asyncio.Event()
        self.wait_started = asyncio.Event()
        self.wait_release = asyncio.Event()

    async def call_tool(self, name, arguments):
        if name in {"wait_for_new_message", "wait_for_settled_message"}:
            self.wait_started.set()
            await asyncio.wait_for(self.wait_release.wait(), arguments["timeout"])
            return {"event": True}
        if name in {"get_me", "incoming_feed_status"}:
            return {"ready": True}
        self.active += 1
        self.peak = max(self.peak, self.active)
        self.entered.append(arguments["page"])
        try:
            await self.release.wait()
            if arguments.get("fail"):
                raise ValueError("read failed")
            return {"page": arguments["page"], "size": arguments["page_size"]}
        finally:
            self.active -= 1

    def streamable_http_app(self):
        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"{}"})
        return app


class ConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Each entrypoint load models a new process, including its own SDK class.
        sdk = type("FastMCP", (FastMCP,), {})
        runtime = types.ModuleType("telegram_mcp.runtime")

        def load_runtime(name):
            if name != "mcp":
                raise AttributeError(name)
            self.mcp = runtime.mcp = sdk()
            return self.mcp

        runtime.__getattr__ = load_runtime
        modules = {
            "mcp": types.ModuleType("mcp"),
            "mcp.server": types.ModuleType("mcp.server"),
            "mcp.server.fastmcp": types.SimpleNamespace(FastMCP=sdk),
            "telegram_mcp": types.ModuleType("telegram_mcp"),
            "telegram_mcp.runtime": runtime,
            "telegram_mcp.runner": types.SimpleNamespace(main=lambda: None),
        }
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {
            "LLV_TELEGRAM_MCP_TOKEN": "T" * 43,
            "LLV_TELEGRAM_VENDOR_DIR": str(Path(__file__).parent),
            "LLV_TELEGRAM_CONNECTOR_LEASE": "",
        }):
            self.entry = runpy.run_path(str(Path(__file__).with_name("telegram-mcp-server.py")))

    async def test_three_large_reads_queue_across_clients(self):
        calls = [asyncio.create_task(self.mcp.dispatch("get_messages", {
            "page": page, "page_size": 120,
        })) for page in (2, 3, 4)]
        try:
            await asyncio.sleep(0.02)
            self.assertEqual(self.mcp.peak, 1)
            self.assertEqual(self.mcp.entered, [2])
            # Control requests stay responsive while tool reads wait.
            self.assertEqual((await asyncio.wait_for(self.request(), 1))[0]["status"], 200)
            self.mcp.release.set()
            results = await asyncio.wait_for(asyncio.gather(*calls), 1)
            self.assertEqual([row["page"] for row in results], [2, 3, 4])
            self.assertEqual(self.mcp.entered, [2, 3, 4])
            self.assertEqual(self.mcp.peak, 1)
        finally:
            for call in calls:
                call.cancel()
            await asyncio.gather(*calls, return_exceptions=True)

    async def test_cancelled_and_failed_reads_release_admission(self):
        first = asyncio.create_task(self.mcp.dispatch("get_messages", {"page": 1, "page_size": 120}))
        queued = asyncio.create_task(self.mcp.dispatch("get_messages", {"page": 2, "page_size": 120}))
        try:
            await asyncio.sleep(0.02)
            queued.cancel()
            first.cancel()
            await asyncio.gather(first, queued, return_exceptions=True)
            self.mcp.release.set()
            with self.assertRaises(ValueError):
                await self.mcp.dispatch("get_messages", {"page": 3, "page_size": 120, "fail": True})
            result = await asyncio.wait_for(self.mcp.dispatch("get_messages", {"page": 4, "page_size": 120}), 1)
            self.assertEqual(result["page"], 4)
            self.assertEqual(self.mcp.peak, 1)
            self.assertNotIn(2, self.mcp.entered)
        finally:
            first.cancel()
            queued.cancel()
            await asyncio.gather(first, queued, return_exceptions=True)

    async def test_local_event_waits_do_not_hold_read_admission(self):
        for name in ("wait_for_new_message", "wait_for_settled_message"):
            with self.subTest(tool=name):
                await self.asyncSetUp()
                # The SDK supplies tool names and arguments by keyword.
                waiting = asyncio.create_task(self.mcp.dispatch(
                    name=name, arguments={"timeout": 3600},
                ))
                calls = []
                try:
                    await asyncio.wait_for(self.mcp.wait_started.wait(), 1)
                    calls = [asyncio.create_task(self.mcp.dispatch("get_messages", {
                        "page": page, "page_size": 120,
                    })) for page in (2, 3, 4)]
                    await asyncio.sleep(0.02)
                    self.assertEqual(self.mcp.entered, [2])
                    self.assertEqual(self.mcp.peak, 1)
                    self.mcp.release.set()
                    results = await asyncio.wait_for(asyncio.gather(*calls), 1)
                    self.assertEqual([row["page"] for row in results], [2, 3, 4])
                    self.assertEqual(self.mcp.entered, [2, 3, 4])
                    self.assertEqual(self.mcp.peak, 1)
                    for read in ("get_me", "incoming_feed_status"):
                        self.assertEqual(await asyncio.wait_for(
                            self.mcp.dispatch(read, {}), 1,
                        ), {"ready": True})
                    self.assertFalse(waiting.done())
                finally:
                    waiting.cancel()
                    for call in calls:
                        call.cancel()
                    await asyncio.gather(waiting, *calls, return_exceptions=True)
                result = await asyncio.wait_for(self.mcp.dispatch("get_messages", {
                    "page": 5, "page_size": 120,
                }), 1)
                self.assertEqual(result["page"], 5)

    async def request(self, session=None, authorized=True):
        headers = [(b"authorization", b"Bearer " + b"T" * 43)] if authorized else []
        if session:
            headers.append((b"mcp-session-id", session))
        messages = []
        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}
        async def send(message):
            messages.append(message)
        await self.mcp.streamable_http_app()({"type": "http", "headers": headers, "path": "/mcp", "method": "POST"}, receive, send)
        return messages

    async def test_respawn_refuses_the_predecessor_session_visibly(self):
        first = await self.request()
        session = dict(first[0]["headers"]).get(b"mcp-session-id")
        self.assertIsNotNone(session)
        self.assertEqual((await self.request(session))[0]["status"], 200)
        await self.asyncSetUp()  # A replacement process at the same URL/token.
        stale = await self.request(session)
        self.assertEqual(stale[0]["status"], 404)
        self.assertIn(b"restarted", stale[1]["body"])
        fresh = await self.request()
        self.assertEqual(fresh[0]["status"], 200)
        self.assertNotEqual(dict(fresh[0]["headers"])[b"mcp-session-id"], session)
        self.assertEqual((await self.request(session, authorized=False))[0]["status"], 401)


if __name__ == "__main__":
    unittest.main()
