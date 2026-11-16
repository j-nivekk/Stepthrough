"""Sending what compresses well compressed: JSON, pages, scripts, styles and SVG, which shrink to about a tenth.

A task with many steps is a few hundred kilobytes of JSON, and in a shared account every browser showing it loads it
again after a change; the app's script is half a megabyte. A proxy in front may compress only HTML, so the app does
it itself. Videos, screenshots and zips are left alone (they are compressed already), and so are partial responses
(video seeking) and anything already encoded. An administrator can switch it off (``app/server_settings.py``).
"""

from __future__ import annotations

import zlib
from typing import Callable

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

COMPRESSIBLE_TYPES = ("application/json", "text/", "application/javascript", "image/svg+xml")
MINIMUM_SIZE = 1024
LEVEL = 5  # nearly the size of the best level, in a third of its time


def _compressible(start: Message) -> bool:
    headers = Headers(raw=start["headers"])
    return (
        start["status"] == 200
        and headers.get("content-type", "").startswith(COMPRESSIBLE_TYPES)
        and "content-encoding" not in headers
        and "content-range" not in headers
    )


class CompressMiddleware:
    def __init__(self, app: ASGIApp, enabled: Callable[[], bool]) -> None:
        self.app = app
        self.enabled = enabled

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] == "HEAD" or not self.enabled():
            await self.app(scope, receive, send)
            return
        request_headers = Headers(scope=scope)
        if "gzip" not in request_headers.get("accept-encoding", "") or "range" in request_headers:
            await self.app(scope, receive, send)
            return

        start: Message | None = None
        held = b""
        compressor = None

        async def send_compressed(message: Message) -> None:
            nonlocal start, held, compressor
            if message["type"] == "http.response.start":
                if not _compressible(message):
                    await send(message)
                    return
                start = message  # held until enough of the body shows whether it is worth it
                return
            if message["type"] != "http.response.body" or (start is None and compressor is None):
                await send(message)
                return
            body: bytes = message.get("body", b"")
            more = message.get("more_body", False)
            if compressor is None:
                assert start is not None
                held += body
                if more and len(held) < MINIMUM_SIZE:
                    return
                if not more and len(held) < MINIMUM_SIZE:
                    await send(start)
                    await send({"type": "http.response.body", "body": held, "more_body": False})
                    start = None
                    return
                headers = MutableHeaders(raw=start["headers"])
                del headers["content-length"]
                headers["content-encoding"] = "gzip"
                headers.add_vary_header("Accept-Encoding")
                await send(start)
                start = None
                compressor = zlib.compressobj(LEVEL, zlib.DEFLATED, 31)  # 31: with the gzip header
                body, held = held, b""
            data = compressor.compress(body)
            if more:
                if data:
                    await send({"type": "http.response.body", "body": data, "more_body": True})
            else:
                await send({"type": "http.response.body", "body": data + compressor.flush(), "more_body": False})

        await self.app(scope, receive, send_compressed)
