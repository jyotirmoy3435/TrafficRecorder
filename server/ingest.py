"""
Batch event ingestion processor for HTTP transactions and WebSocket frames.
Executes batch commits inside single atomic SQLite transactions with error resilience.
"""
import base64
import json
import logging
import sqlite3
import time
from typing import Any, Dict, List, Tuple

from server import storage

logger = logging.getLogger(__name__)


def normalize_headers(headers_data: Any) -> List[Tuple[str, str]]:
    """Convert various header formats (dict, list of tuples/dicts) into a normalized list of (name, value)."""
    normalized = []
    if not headers_data:
        return normalized

    if isinstance(headers_data, dict):
        for k, v in headers_data.items():
            normalized.append((str(k), str(v)))
    elif isinstance(headers_data, list):
        for item in headers_data:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                normalized.append((str(item[0]), str(item[1])))
            elif isinstance(item, dict) and "name" in item and "value" in item:
                normalized.append((str(item["name"]), str(item["value"])))
    return normalized


def process_batch(
    conn: sqlite3.Connection,
    session_id: str,
    events: List[Dict[str, Any]]
) -> Tuple[int, int]:
    """
    Process and ingest a batch of events inside an atomic transaction.
    Returns: (processed_count, error_count)
    """
    processed_count = 0
    error_count = 0
    now_ms = int(time.time() * 1000)

    # Cache connection IDs for WebSockets in this batch to reduce SELECT queries
    ws_conn_cache: Dict[str, int] = {}

    with conn:
        for event in events:
            try:
                event_type = event.get("event_type", "").lower()
                req_id = str(event.get("request_id", ""))
                ts = int(event.get("timestamp", now_ms))

                if event_type == "request":
                    url = event.get("url", "")
                    method = event.get("method", "GET").upper()
                    resource_type = event.get("resource_type", "")
                    headers = normalize_headers(event.get("headers"))
                    post_data = event.get("post_data")
                    is_post_base64 = event.get("post_data_base64", False)

                    req_payload_id = None
                    if post_data:
                        try:
                            if is_post_base64:
                                body_bytes = base64.b64decode(post_data)
                            elif isinstance(post_data, str):
                                body_bytes = post_data.encode("utf-8", errors="replace")
                            elif isinstance(post_data, bytes):
                                body_bytes = post_data
                            else:
                                body_bytes = str(post_data).encode("utf-8")
                            
                            req_payload_id = storage.store_payload(
                                conn, body_bytes, mime_type=event.get("mime_type")
                            )
                        except Exception as e:
                            logger.warning("Failed to store request payload for %s: %s", req_id, e)

                    # Check if transaction already exists (e.g. response or extra headers received earlier)
                    cursor = conn.cursor()
                    cursor.execute(
                        "SELECT id FROM http_transactions WHERE session_id = ? AND request_id = ?",
                        (session_id, req_id),
                    )
                    existing_txn = cursor.fetchone()

                    if existing_txn:
                        txn_id = existing_txn[0]
                        cursor.execute(
                            """
                            UPDATE http_transactions
                            SET url = ?, method = ?, resource_type = ?, started_at = ?,
                                request_payload_id = COALESCE(request_payload_id, ?)
                            WHERE id = ?
                            """,
                            (url, method, resource_type, ts, req_payload_id, txn_id),
                        )
                    else:
                        cursor.execute(
                            """
                            INSERT INTO http_transactions (
                                session_id, request_id, url, method, resource_type,
                                started_at, request_payload_id
                            ) VALUES (?, ?, ?, ?, ?, ?, ?)
                            """,
                            (session_id, req_id, url, method, resource_type, ts, req_payload_id),
                        )
                        txn_id = cursor.lastrowid

                    # Insert request headers
                    for seq, (hname, hval) in enumerate(headers):
                        cursor.execute(
                            """
                            INSERT INTO http_headers (transaction_id, direction, sequence, name, value)
                            VALUES (?, 0, ?, ?, ?)
                            """,
                            (txn_id, seq, hname, hval),
                        )

                    processed_count += 1

                elif event_type == "response":
                    status_code = event.get("status_code")
                    status_text = event.get("status_text", "")
                    mime_type = event.get("mime_type")
                    protocol = event.get("protocol")
                    from_cache = 1 if event.get("from_cache") else 0
                    headers = normalize_headers(event.get("headers"))

                    cursor = conn.cursor()
                    cursor.execute(
                        "SELECT id, started_at FROM http_transactions WHERE session_id = ? AND request_id = ?",
                        (session_id, req_id),
                    )
                    existing_txn = cursor.fetchone()

                    duration_ms = None
                    if existing_txn:
                        txn_id = existing_txn[0]
                        started_at = existing_txn[1]
                        if started_at and ts >= started_at:
                            duration_ms = round((ts - started_at), 2)

                        cursor.execute(
                            """
                            UPDATE http_transactions
                            SET status_code = ?, status_text = ?, mime_type = ?,
                                protocol = ?, from_cache = ?, completed_at = ?, duration_ms = ?
                            WHERE id = ?
                            """,
                            (status_code, status_text, mime_type, protocol, from_cache, ts, duration_ms, txn_id),
                        )
                    else:
                        # Response arrived before request info
                        cursor.execute(
                            """
                            INSERT INTO http_transactions (
                                session_id, request_id, url, method, started_at, completed_at,
                                status_code, status_text, mime_type, protocol, from_cache
                            ) VALUES (?, ?, '', 'GET', ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (session_id, req_id, ts, ts, status_code, status_text, mime_type, protocol, from_cache),
                        )
                        txn_id = cursor.lastrowid

                    # Insert response headers
                    for seq, (hname, hval) in enumerate(headers):
                        cursor.execute(
                            """
                            INSERT INTO http_headers (transaction_id, direction, sequence, name, value)
                            VALUES (?, 1, ?, ?, ?)
                            """,
                            (txn_id, seq, hname, hval),
                        )

                    processed_count += 1

                elif event_type == "response_body":
                    body_data = event.get("body")
                    is_base64 = event.get("base64_encoded", False)
                    mime_type = event.get("mime_type")

                    if body_data is not None:
                        try:
                            if is_base64:
                                body_bytes = base64.b64decode(body_data)
                            elif isinstance(body_data, str):
                                body_bytes = body_data.encode("utf-8", errors="replace")
                            elif isinstance(body_data, bytes):
                                body_bytes = body_data
                            else:
                                body_bytes = str(body_data).encode("utf-8")

                            resp_payload_id = storage.store_payload(conn, body_bytes, mime_type=mime_type)

                            cursor = conn.cursor()
                            cursor.execute(
                                """
                                UPDATE http_transactions
                                SET response_payload_id = ?,
                                    completed_at = COALESCE(completed_at, ?)
                                WHERE session_id = ? AND request_id = ?
                                """,
                                (resp_payload_id, ts, session_id, req_id),
                            )
                        except Exception as e:
                            logger.warning("Failed to store response body for %s: %s", req_id, e)

                    processed_count += 1

                elif event_type == "ws_created":
                    url = event.get("url", "")
                    cursor = conn.cursor()
                    cursor.execute(
                        """
                        INSERT INTO websocket_connections (session_id, request_id, url, created_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (session_id, req_id, url, ts),
                    )
                    ws_conn_cache[req_id] = cursor.lastrowid
                    processed_count += 1

                elif event_type == "ws_message":
                    conn_id = ws_conn_cache.get(req_id)
                    cursor = conn.cursor()
                    if conn_id is None:
                        cursor.execute(
                            "SELECT id FROM websocket_connections WHERE session_id = ? AND request_id = ?",
                            (session_id, req_id),
                        )
                        row = cursor.fetchone()
                        if row:
                            conn_id = row[0]
                            ws_conn_cache[req_id] = conn_id
                        else:
                            # WebSocket connection created on the fly if not seen yet
                            cursor.execute(
                                """
                                INSERT INTO websocket_connections (session_id, request_id, url, created_at)
                                VALUES (?, ?, ?, ?)
                                """,
                                (session_id, req_id, event.get("url", "ws://unknown"), ts),
                            )
                            conn_id = cursor.lastrowid
                            ws_conn_cache[req_id] = conn_id

                    direction = 0 if event.get("direction") == "sent" else 1
                    opcode = int(event.get("opcode", 1))
                    is_binary = 1 if event.get("is_binary") else 0
                    payload_data = event.get("payload_data", "")

                    if is_binary or event.get("base64_encoded"):
                        try:
                            msg_bytes = base64.b64decode(payload_data)
                        except Exception:
                            msg_bytes = str(payload_data).encode("utf-8", errors="replace")
                    else:
                        msg_bytes = str(payload_data).encode("utf-8", errors="replace")

                    payload_id = storage.store_payload(conn, msg_bytes, mime_type="text/plain" if opcode == 1 else "application/octet-stream")

                    cursor.execute(
                        """
                        INSERT INTO websocket_messages (
                            connection_id, direction, timestamp, opcode, is_binary, payload_id
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (conn_id, direction, ts, opcode, is_binary, payload_id),
                    )
                    processed_count += 1

                elif event_type == "ws_closed":
                    cursor = conn.cursor()
                    cursor.execute(
                        """
                        UPDATE websocket_connections
                        SET closed_at = ?
                        WHERE session_id = ? AND request_id = ?
                        """,
                        (ts, session_id, req_id),
                    )
                    processed_count += 1

                elif event_type in ("error", "capture_error"):
                    error_msg = event.get("error_message") or event.get("error", "Unknown error")
                    cursor = conn.cursor()
                    cursor.execute(
                        """
                        INSERT INTO capture_errors (session_id, request_id, event_type, error_message, timestamp)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (session_id, req_id, event.get("sub_type", event_type), error_msg, ts),
                    )
                    if req_id:
                        cursor.execute(
                            "UPDATE http_transactions SET error = ? WHERE session_id = ? AND request_id = ?",
                            (error_msg, session_id, req_id),
                        )
                    processed_count += 1

                else:
                    logger.debug("Unknown event type ignored: %s", event_type)

            except Exception as e:
                error_count += 1
                logger.error("Error processing event in batch: %s", e, exc_info=True)

    return processed_count, error_count
