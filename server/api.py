"""
FastAPI application router and REST endpoints for Traffic Recorder Server.
"""
import json
import os
import time
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server import db, exporter, ingest, storage
from server.config import API_TOKEN, BLOBS_DIR, DATABASE_PATH
from server.models import (
    HealthResponse,
    IngestBatchRequest,
    IngestResponse,
    SessionStartRequest,
    SessionStopRequest,
)

router = APIRouter()
_server_start_time = time.time()


def get_db():
    conn = db.get_connection()
    return conn


@router.get("/health", response_model=HealthResponse)
def health_check(conn=Depends(get_db)):
    """Health check and live database storage diagnostics."""
    db_size = DATABASE_PATH.stat().st_size if DATABASE_PATH.exists() else 0

    blobs_count = 0
    blobs_size = 0
    if BLOBS_DIR.exists():
        for root, _, files in os.walk(BLOBS_DIR):
            for f in files:
                blobs_count += 1
                blobs_size += os.path.getsize(os.path.join(root, f))

    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM sessions")
    total_sessions = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM http_transactions")
    total_txns = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM websocket_messages")
    total_ws = cursor.fetchone()[0]

    return HealthResponse(
        status="ok",
        service="Traffic Recorder Companion Server",
        version="1.1.0",
        db_size_bytes=db_size,
        blobs_count=blobs_count,
        blobs_size_bytes=blobs_size,
        total_sessions=total_sessions,
        total_transactions=total_txns,
        total_ws_messages=total_ws,
        uptime_seconds=round(time.time() - _server_start_time, 2),
    )


@router.get("/stats")
def get_stats(conn=Depends(get_db)):
    """Detailed storage, compression, and deduplication statistics."""
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*), SUM(original_size), SUM(stored_size) FROM payloads")
    p_count, orig_sum, stored_sum = cursor.fetchone()
    orig_sum = orig_sum or 0
    stored_sum = stored_sum or 0

    savings_bytes = orig_sum - stored_sum
    savings_ratio = round((savings_bytes / orig_sum * 100), 2) if orig_sum > 0 else 0.0

    return {
        "payloads_count": p_count or 0,
        "original_payload_bytes": orig_sum,
        "stored_payload_bytes": stored_sum,
        "compression_savings_bytes": savings_bytes,
        "compression_savings_percent": savings_ratio,
    }


@router.post("/session/start")
def start_session(req: SessionStartRequest, conn=Depends(get_db)):
    """Register or initialize a recording session."""
    now_ms = req.started_at or int(time.time() * 1000)
    with conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO sessions (session_id, tab_id, initial_url, title, started_at, status)
            VALUES (?, ?, ?, ?, ?, 'recording')
            ON CONFLICT(session_id) DO UPDATE SET
                tab_id = COALESCE(excluded.tab_id, sessions.tab_id),
                initial_url = COALESCE(excluded.initial_url, sessions.initial_url),
                title = COALESCE(excluded.title, sessions.title),
                status = 'recording'
            """,
            (req.session_id, req.tab_id, req.initial_url, req.title, now_ms),
        )
    return {"status": "ok", "session_id": req.session_id, "started_at": now_ms}


@router.post("/session/stop")
def stop_session(req: SessionStopRequest, conn=Depends(get_db)):
    """Mark session as completed and finalize metadata."""
    now_ms = req.ended_at or int(time.time() * 1000)
    stats_str = json.dumps(req.stats or {})
    with conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE sessions
            SET ended_at = ?, status = 'completed', stats_json = ?
            WHERE session_id = ?
            """,
            (now_ms, stats_str, req.session_id),
        )
    return {"status": "ok", "session_id": req.session_id, "ended_at": now_ms}


@router.post("/ingest", response_model=IngestResponse)
def ingest_batch(req: IngestBatchRequest, conn=Depends(get_db)):
    """Ingest a batch of captured CDP events."""
    if not req.events:
        return IngestResponse(
            status="ok",
            processed_count=0,
            persisted_at=int(time.time() * 1000),
            error_count=0,
        )

    processed, errors = ingest.process_batch(conn, req.session_id, req.events)
    return IngestResponse(
        status="ok",
        processed_count=processed,
        persisted_at=int(time.time() * 1000),
        error_count=errors,
    )


@router.get("/sessions")
def list_sessions(conn=Depends(get_db)):
    """List all recorded sessions with aggregate activity metrics."""
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT s.id, s.session_id, s.tab_id, s.initial_url, s.title, s.started_at, s.ended_at, s.status,
               (SELECT COUNT(*) FROM http_transactions WHERE session_id = s.session_id) AS http_count,
               (SELECT COUNT(*) FROM websocket_connections WHERE session_id = s.session_id) AS ws_conn_count,
               (SELECT COUNT(*) FROM capture_errors WHERE session_id = s.session_id) AS error_count
        FROM sessions s
        ORDER BY s.started_at DESC
        """
    )
    rows = cursor.fetchall()
    return [dict(r) for r in rows]


@router.get("/sessions/{session_id}")
def get_session(session_id: str, conn=Depends(get_db)):
    """Get single session details."""
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,))
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    return dict(row)


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, conn=Depends(get_db)):
    """Delete a session and all its associated traffic."""
    with conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        cursor.execute("DELETE FROM http_transactions WHERE session_id = ?", (session_id,))
        cursor.execute("DELETE FROM websocket_connections WHERE session_id = ?", (session_id,))
        cursor.execute("DELETE FROM capture_errors WHERE session_id = ?", (session_id,))
    return {"status": "ok", "deleted_session_id": session_id}


@router.get("/sessions/{session_id}/transactions")
def list_transactions(
    session_id: str,
    search: Optional[str] = None,
    method: Optional[str] = None,
    status: Optional[int] = None,
    resource_type: Optional[str] = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    conn=Depends(get_db),
):
    """Query HTTP transactions with search, filters and pagination."""
    query = """
        SELECT id, request_id, url, method, resource_type, started_at, completed_at,
               duration_ms, status_code, status_text, mime_type, protocol, from_cache,
               error, request_payload_id, response_payload_id
        FROM http_transactions
        WHERE session_id = ?
    """
    params = [session_id]

    if search:
        query += " AND (url LIKE ? OR mime_type LIKE ?)"
        params.extend([f"%{search}%", f"%{search}%"])
    if method:
        query += " AND method = ?"
        params.append(method.upper())
    if status is not None:
        query += " AND status_code = ?"
        params.append(status)
    if resource_type:
        query += " AND resource_type = ?"
        params.append(resource_type)

    # Count total
    count_query = f"SELECT COUNT(*) FROM ({query})"
    cursor = conn.cursor()
    cursor.execute(count_query, params)
    total_count = cursor.fetchone()[0]

    # Paginate
    query += " ORDER BY started_at ASC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    cursor.execute(query, params)
    rows = cursor.fetchall()

    return {
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "items": [dict(r) for r in rows],
    }


@router.get("/transactions/{transaction_id}")
def get_transaction(transaction_id: int, conn=Depends(get_db)):
    """Get full details of a specific HTTP transaction including headers and preview."""
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM http_transactions WHERE id = ?", (transaction_id,))
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Transaction not found")

    txn = dict(row)

    # Headers
    cursor.execute(
        "SELECT direction, name, value, sequence FROM http_headers WHERE transaction_id = ? ORDER BY sequence ASC",
        (transaction_id,),
    )
    headers = cursor.fetchall()
    txn["request_headers"] = [dict(h) for h in headers if h["direction"] == 0]
    txn["response_headers"] = [dict(h) for h in headers if h["direction"] == 1]

    # Previews
    for p_field, p_key in [("request_payload_id", "request_body"), ("response_payload_id", "response_body")]:
        pid = txn.get(p_field)
        if pid:
            try:
                body_bytes, p_mime, enc, orig_sz, stored_sz = storage.retrieve_payload(conn, pid)
                is_text = False
                text_preview = None
                try:
                    text_preview = body_bytes.decode("utf-8")
                    is_text = True
                except UnicodeDecodeError:
                    text_preview = None

                txn[p_key] = {
                    "payload_id": pid,
                    "mime_type": p_mime,
                    "original_size": orig_sz,
                    "stored_size": stored_sz,
                    "encoding": enc,
                    "is_text": is_text,
                    "preview": text_preview[:50000] if text_preview is not None else None,
                    "has_raw": True,
                }
            except Exception as e:
                txn[p_key] = {"error": str(e)}
        else:
            txn[p_key] = None

    return txn


@router.get("/sessions/{session_id}/websockets")
def list_websockets(session_id: str, conn=Depends(get_db)):
    """List WebSocket connections and their message statistics."""
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT w.id, w.request_id, w.url, w.created_at, w.closed_at,
               (SELECT COUNT(*) FROM websocket_messages WHERE connection_id = w.id) AS message_count,
               (SELECT COUNT(*) FROM websocket_messages WHERE connection_id = w.id AND direction = 0) AS sent_count,
               (SELECT COUNT(*) FROM websocket_messages WHERE connection_id = w.id AND direction = 1) AS received_count
        FROM websocket_connections w
        WHERE w.session_id = ?
        ORDER BY w.created_at ASC
        """,
        (session_id,),
    )
    return [dict(r) for r in cursor.fetchall()]


@router.get("/websockets/{connection_id}/messages")
def list_websocket_messages(
    connection_id: int,
    direction: Optional[int] = None,
    limit: int = Query(default=200, le=1000),
    offset: int = 0,
    conn=Depends(get_db),
):
    """List messages for a specific WebSocket connection."""
    query = """
        SELECT m.id, m.connection_id, m.direction, m.timestamp, m.opcode, m.is_binary, m.payload_id,
               p.original_size, p.mime_type
        FROM websocket_messages m
        JOIN payloads p ON m.payload_id = p.id
        WHERE m.connection_id = ?
    """
    params = [connection_id]
    if direction is not None:
        query += " AND m.direction = ?"
        params.append(direction)

    count_cursor = conn.cursor()
    count_cursor.execute(f"SELECT COUNT(*) FROM ({query})", params)
    total = count_cursor.fetchone()[0]

    query += " ORDER BY m.timestamp ASC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    cursor = conn.cursor()
    cursor.execute(query, params)
    rows = cursor.fetchall()

    messages = []
    for r in rows:
        md = dict(r)
        # Fetch preview of message payload
        try:
            body_bytes, _, _, _, _ = storage.retrieve_payload(conn, md["payload_id"])
            try:
                md["preview"] = body_bytes.decode("utf-8")
            except UnicodeDecodeError:
                md["preview"] = f"<Binary {len(body_bytes)} bytes>"
        except Exception:
            md["preview"] = "<Unavailable>"
        messages.append(md)

    return {
        "total": total,
        "items": messages,
    }


@router.get("/sessions/{session_id}/errors")
def list_session_errors(session_id: str, conn=Depends(get_db)):
    """List all capture warnings, network failures or queue drops."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, request_id, event_type, error_message, timestamp FROM capture_errors WHERE session_id = ? ORDER BY timestamp ASC",
        (session_id,),
    )
    return [dict(r) for r in cursor.fetchall()]


@router.get("/payloads/{payload_id}/raw")
def get_raw_payload(payload_id: int, conn=Depends(get_db)):
    """Download raw binary decompressed payload with appropriate Content-Type."""
    try:
        body_bytes, mime, enc, orig_sz, stored_sz = storage.retrieve_payload(conn, payload_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Payload not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return Response(content=body_bytes, media_type=mime or "application/octet-stream")


@router.get("/sessions/{session_id}/export/har")
def export_session_har(session_id: str, conn=Depends(get_db)):
    """Download entire session as standard HAR 1.2 file."""
    try:
        har_data = exporter.export_har(conn, session_id)
        content_str = json.dumps(har_data, indent=2)
        return Response(
            content=content_str,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="traffic-{session_id}.har"'},
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")


@router.get("/sessions/{session_id}/export/json")
def export_session_json(session_id: str, conn=Depends(get_db)):
    """Download entire session as complete structured JSON."""
    try:
        data = exporter.export_json(conn, session_id)
        content_str = json.dumps(data, indent=2)
        return Response(
            content=content_str,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="traffic-{session_id}.json"'},
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")
