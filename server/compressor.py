"""
High-performance compression and content hashing module.
Uses Zstandard (zstd) with adaptive ratio check and SHA-256 for deduplication.
"""
import hashlib
import zlib
from typing import Tuple

try:
    import zstandard as zstd
    HAS_ZSTD = True
    _cctx = zstd.ZstdCompressor(level=3)
    _dctx = zstd.ZstdDecompressor()
except ImportError:
    HAS_ZSTD = False
    _cctx = None
    _dctx = None


def sha256_hash(data: bytes) -> str:
    """Compute standard hexadecimal SHA-256 hash of byte sequence."""
    return hashlib.sha256(data).hexdigest()


def compress(data: bytes, threshold_ratio: float = 0.95) -> Tuple[bytes, str, bool]:
    """
    Compress bytes adaptively.
    Returns: (stored_bytes, encoding_name, is_compressed)
    If compressed bytes size >= original * threshold_ratio, original is returned.
    """
    if not data:
        return b"", "identity", False

    original_size = len(data)
    
    # Don't bother compressing tiny payloads (< 64 bytes)
    if original_size < 64:
        return data, "identity", False

    if HAS_ZSTD:
        try:
            compressed = _cctx.compress(data)
            if len(compressed) < original_size * threshold_ratio:
                return compressed, "zstd", True
        except Exception:
            pass
    else:
        # Fallback to zlib/deflate if zstandard is missing
        try:
            compressed = zlib.compress(data, level=6)
            if len(compressed) < original_size * threshold_ratio:
                return compressed, "deflate", True
        except Exception:
            pass

    return data, "identity", False


def decompress(data: bytes, encoding: str) -> bytes:
    """
    Decompress payload bytes according to recorded encoding.
    """
    if not data or encoding == "identity":
        return data

    if encoding == "zstd":
        if not HAS_ZSTD:
            raise RuntimeError("zstandard library not installed, cannot decompress zstd payload")
        return _dctx.decompress(data)
    elif encoding == "deflate" or encoding == "zlib":
        return zlib.decompress(data)
    elif encoding == "gzip":
        import gzip
        return gzip.decompress(data)
    else:
        raise ValueError(f"Unknown payload encoding: {encoding}")
