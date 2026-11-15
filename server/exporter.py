"""
Session export module for standard HAR 1.2 and structured JSON formats.
Allows seamless importing into Chrome DevTools, Charles, Fiddler, etc.
"""
import base64
import datetime
import json
import sqlite3
from typing import Any, Dict, List
from urllib.parse import parse_qsl, urlparse

from server import storage


def _iso_timestamp(epoch_ms: int) -> str:
    """Convert epoch milliseconds into ISO 8601 UTC string."""
    if not epoch_ms:
        return datetime.datetime.now(datetime.timezone.utc).isoformat()
    return datetime.datetime.fromtimestamp(epoch_ms / 1000.0, tz=datetime.timezone.utc).isoformat()


def export_har(conn: sqlite3.Connection, session_id: str) -> Dict[str, Any]:
    """Export complete HTTP and WebSocket session data as standard HAR 1.2."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT session_id, tab_id, initial_url, title, started_at, ended_at FROM sessions WHERE session_id = ?",
        (session_id,),
    )
    session_row = cursor.fetchone()
    if not session_row:
        raise KeyError(f"Session '{session_id}' not found")

    started_at = session_row["started_at"]
    title = session_row["title"] or session_row["initial_url"] or f"Session {session_id}"

    # Fetch all HTTP transactions
    cursor.execute(
        """
        SELECT id, request_id, url, method, resource_type, started_at, completed_at,
               duration_ms, status_code, status_text, mime_type, protocol, from_cache,
               error, request_payload_id, response_payload_id
        FROM http_transactions
        WHERE session_id = ?
        ORDER BY started_at ASC
        """,
        (session_id,),
    )
    transactions = cursor.fetchall()

    entries: List[Dict[str, Any]] = []

    for txn in transactions:
        txn_id = txn["id"]
        url = txn["url"]
        method = txn["method"]
        status = txn["status_code"] or (0 if txn["error"] else 200)
        status_text = txn["status_text"] or ("Error" if txn["error"] else "OK")
        protocol = txn["protocol"] or "HTTP/1.1"
        duration = txn["duration_ms"] if txn["duration_ms"] is not None else 0.0

        # Fetch headers
        cursor.execute(
            "SELECT direction, name, value FROM http_headers WHERE transaction_id = ? ORDER BY sequence ASC",
            (txn_id,),
        )
        all_headers = cursor.fetchall()
        req_headers = [{"name": h["name"], "value": h["value"]} for h in all_headers if h["direction"] == 0]
        resp_headers = [{"name": h["name"], "value": h["value"]} for h in all_headers if h["direction"] == 1]

        # Parse query string
        parsed_url = urlparse(url)
        query_params = [{"name": k, "value": v} for k, v in parse_qsl(parsed_url.query)]

        # Fetch request post data if available
        post_data_obj = None
        req_payload_id = txn["request_payload_id"]
        if req_payload_id:
            try:
                body_bytes, p_mime, _, orig_sz, _ = storage.retrieve_payload(conn, req_payload_id)
                try:
                    text_content = body_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    text_content = base64.b64encode(body_bytes).decode("ascii")
                post_data_obj = {
                    "mimeType": p_mime or "application/octet-stream",
                    "text": text_content,
                }
            except Exception:
                pass

        # Fetch response content if available
        resp_content_obj: Dict[str, Any] = {
            "size": 0,
            "mimeType": txn["mime_type"] or "application/octet-stream",
        }
        resp_payload_id = txn["response_payload_id"]
        if resp_payload_id:
            try:
                body_bytes, p_mime, _, orig_sz, _ = storage.retrieve_payload(conn, resp_payload_id)
                resp_content_obj["size"] = orig_sz
                if p_mime:
                    resp_content_obj["mimeType"] = p_mime

                # Check if text or binary
                is_text = False
                if p_mime and any(t in p_mime.lower() for t in ("json", "text", "javascript", "html", "xml", "css", "svg")):
                    is_text = True

                if is_text:
                    try:
                        resp_content_obj["text"] = body_bytes.decode("utf-8")
                    except UnicodeDecodeError:
                        resp_content_obj["text"] = base64.b64encode(body_bytes).decode("ascii")
                        resp_content_obj["encoding"] = "base64"
                else:
                    resp_content_obj["text"] = base64.b64encode(body_bytes).decode("ascii")
                    resp_content_obj["encoding"] = "base64"
            except Exception:
                pass

        entry: Dict[str, Any] = {
            "pageref": session_id,
            "startedDateTime": _iso_timestamp(txn["started_at"]),
            "time": duration,
            "request": {
                "method": method,
                "url": url,
                "httpVersion": protocol,
                "headers": req_headers,
                "queryString": query_params,
                "cookies": [],
                "headersSize": -1,
                "bodySize": post_data_obj.get("size", len(post_data_obj["text"])) if post_data_obj and "text" in post_data_obj else 0,
            },
            "response": {
                "status": status,
                "statusText": status_text,
                "httpVersion": protocol,
                "headers": resp_headers,
                "cookies": [],
                "content": resp_content_obj,
                "redirectURL": "",
                "headersSize": -1,
                "bodySize": resp_content_obj["size"],
            },
            "cache": {},
            "timings": {
                "send": 0,
                "wait": duration,
                "receive": 0,
            },
            "_resourceType": txn["resource_type"],
            "_error": txn["error"],
        }
        if post_data_obj:
            entry["request"]["postData"] = post_data_obj

        entries.append(entry)

    har: Dict[str, Any] = {
        "log": {
            "version": "1.2",
            "creator": {
                "name": "Traffic Recorder",
                "version": "1.1.0",
            },
            "pages": [
                {
                    "startedDateTime": _iso_timestamp(started_at),
                    "id": session_id,
                    "title": title,
                    "pageTimings": {
                        "onContentLoad": -1,
                        "onLoad": -1,
                    },
                }
            ],
            "entries": entries,
        }
    }
    return har


def export_json(conn: sqlite3.Connection, session_id: str) -> Dict[str, Any]:
    """Export complete session with HTTP, WebSocket messages and errors as structured JSON."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT session_id, tab_id, initial_url, title, started_at, ended_at, status FROM sessions WHERE session_id = ?",
        (session_id,),
    )
    session_row = cursor.fetchone()
    if not session_row:
        raise KeyError(f"Session '{session_id}' not found")

    session_data = dict(session_row)

    # HTTP Transactions
    cursor.execute(
        """
        SELECT id, request_id, url, method, resource_type, started_at, completed_at,
               duration_ms, status_code, status_text, mime_type, protocol, from_cache,
               error, request_payload_id, response_payload_id
        FROM http_transactions
        WHERE session_id = ?
        ORDER BY started_at ASC
        """,
        (session_id,),
    )
    raw_txns = cursor.fetchall()
    txns = []
    for t in raw_txns:
        td = dict(t)
        # Add headers
        cursor.execute(
            "SELECT direction, sequence, name, value FROM http_headers WHERE transaction_id = ? ORDER BY sequence ASC",
            (t["id"],),
        )
        headers = cursor.fetchall()
        td["request_headers"] = [dict(h) for h in headers if h["direction"] == 0]
        td["response_headers"] = [dict(h) for h in headers if h["direction"] == 1]
        txns.append(td)

    # WebSockets
    cursor.execute(
        "SELECT id, request_id, url, created_at, closed_at FROM websocket_connections WHERE session_id = ?",
        (session_id,),
    )
    ws_conns = []
    for conn_row in cursor.fetchall():
        cd = dict(conn_row)
        cursor.execute(
            """
            SELECT id, direction, timestamp, opcode, is_binary, payload_id
            FROM websocket_messages
            WHERE connection_id = ?
            ORDER BY timestamp ASC
            """,
            (conn_row["id"],),
        )
        cd["messages"] = [dict(m) for m in cursor.fetchall()]
        ws_conns.append(cd)

    # Errors
    cursor.execute(
        "SELECT request_id, event_type, error_message, timestamp FROM capture_errors WHERE session_id = ? ORDER BY timestamp ASC",
        (session_id,),
    )
    errors = [dict(e) for e in cursor.fetchall()]

    return {
        "session": session_data,
        "http_transactions": txns,
        "websocket_connections": ws_conns,
        "capture_errors": errors,
    }
