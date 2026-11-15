"""
Pydantic data models for request validation and API responses.
"""
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field


class SessionStartRequest(BaseModel):
    session_id: str = Field(..., description="Unique UUID for this recording session")
    tab_id: Optional[int] = Field(None, description="Chrome Tab ID being recorded")
    initial_url: Optional[str] = Field(None, description="Initial tab URL")
    title: Optional[str] = Field(None, description="Initial tab title")
    started_at: Optional[int] = Field(None, description="Epoch timestamp in ms")


class SessionStopRequest(BaseModel):
    session_id: str = Field(..., description="Unique UUID of session to stop")
    ended_at: Optional[int] = Field(None, description="Epoch timestamp in ms")
    stats: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Session statistics")


class IngestBatchRequest(BaseModel):
    session_id: str = Field(..., description="Target recording session ID")
    events: List[Dict[str, Any]] = Field(..., description="List of recorded events in chronological order")


class IngestResponse(BaseModel):
    status: str = "ok"
    processed_count: int
    persisted_at: int
    error_count: int = 0


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "Traffic Recorder Companion Server"
    version: str = "1.1.0"
    db_size_bytes: int
    blobs_count: int
    blobs_size_bytes: int
    total_sessions: int
    total_transactions: int
    total_ws_messages: int
    uptime_seconds: float
