"""Live feed: a read-only peek at a sink topic, to see whether data is flowing.

The consumer config mirrors foundry-processor's `client_config` (same keys, same
librdkafka settings, credentials from `$FOUNDRY_SECRETS_DIR/<SecretRef>/username|password`),
with two deliberate differences so peeking can never disturb the pipeline:

* it never joins a consumer group: partitions are assigned directly, under a throwaway
  group.id, and ConsumerGroup from the manifest is ignored;
* it never commits offsets.

It starts a few messages before the end of each partition (recent history), then follows
new messages. Each message is checked against the sink's Ontology schema file.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import logging
import math
import random
import re
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path

import yaml

HISTORY = 20  # recent messages to show when a feed opens
PREVIEW_BYTES = 4096
DEFAULT_SECRETS_DIR = Path("/var/run/secrets/foundry")
log = logging.getLogger("foundry_studio.peek")


class PeekError(Exception):
    pass


def _str(value) -> str:
    return str(value).lower() if isinstance(value, bool) else str(value)


def bind(settings: dict, clusters: list[dict]) -> dict:
    """Swap the manifest's connection for this environment's, like the foundry watcher does
    for processors: the cluster whose `match` equals Brokers supplies the connection."""
    cluster = next((c for c in clusters if c["match"] == (settings or {}).get("Brokers")), None)
    return dict(cluster["connection"]) if cluster else dict(settings or {})


def client_config(settings: dict, secrets_dir: Path) -> dict:
    """ConnectionSettings -> librdkafka consumer config, as the processor runtime builds it."""
    cfg: dict[str, str] = {}
    protocol = "plaintext"
    secret_ref = None
    for key, value in (settings or {}).items():
        value = _str(value)
        if key == "Brokers":
            cfg["bootstrap.servers"] = value
        elif key == "SecurityProtocol":
            protocol = value.lower()
            cfg["security.protocol"] = protocol
        elif key == "SaslMechanism":
            cfg["sasl.mechanism"] = value
        elif key == "SecretRef":
            secret_ref = value
        elif key == "ConsumerGroup":
            pass  # never join the pipeline's group: peeking must not take partitions from it
        elif "." in key:
            cfg[key] = value
        else:
            raise PeekError(f"unknown connection setting {key!r}")
    if not cfg.get("bootstrap.servers"):
        raise PeekError("connection settings have no Brokers")
    if protocol.startswith("sasl"):
        if not cfg.get("sasl.mechanism"):
            raise PeekError(f"SecurityProtocol {protocol.upper()} needs a SaslMechanism")
        if not secret_ref:
            raise PeekError(f"SecurityProtocol {protocol.upper()} needs a SecretRef")
        for name, key in (("username", "sasl.username"), ("password", "sasl.password")):
            path = secrets_dir / secret_ref / name
            try:
                cfg[key] = path.read_text().rstrip("\r\n")
            except OSError:
                raise PeekError(
                    f"secret {secret_ref!r}: can't read {path}. Put the credentials in "
                    f"$FOUNDRY_SECRETS_DIR/{secret_ref}/username and /password (as the processor runtime does)"
                ) from None
    cfg.update({
        "group.id": f"foundry-studio-peek-{uuid.uuid4().hex[:12]}",
        "enable.auto.commit": "false",
        "enable.auto.offset.store": "false",
        "client.id": "foundry-studio-peek",
        "log_level": "3",
    })
    return cfg


_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")
_BASE64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")


def _field_error(kind: str, value) -> str | None:
    """foundry's field types (schemas/*.yaml): uuid, string, base64, datetime, ip."""
    if kind == "string":
        return None if isinstance(value, str) else "expected a string"
    if not isinstance(value, str):
        return f"expected {kind} text"
    if kind == "uuid":
        try:
            uuid.UUID(value)
            return None if len(value) == 36 else "not a UUID"
        except ValueError:
            return "not a UUID"
    if kind == "base64":
        return None if len(value) % 4 == 0 and _BASE64.match(value) else "not base64"
    if kind == "datetime":
        if not _RFC3339.match(value):
            return "not an RFC 3339 date-time"
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
            return None
        except ValueError:
            return "not an RFC 3339 date-time"
    if kind == "ip":
        try:
            ipaddress.ip_address(value)
            return None
        except ValueError:
            return "not an IP address"
    return None  # a type this Studio doesn't know: don't flag it


class FormatChecker:
    """Does a message match its topic's schema?

    foundry's schemas (`format: json|xml` + `fields: {name: type}`) are checked field by
    field, as the SDKs decode them: exactly those fields, each of its type. Older
    pipelines' JSON Schema files are validated with jsonschema; XSDs get a well-formedness check.
    """

    def __init__(self, schema: str | None, filename: str | None, data: bytes | None):
        self.schema = schema
        self.kind = None
        self.validator = None
        self.fields: dict[str, str] = {}
        if not filename or data is None:
            return
        if filename.endswith((".yaml", ".yml")):
            try:
                spec = yaml.safe_load(data) or {}
            except yaml.YAMLError:
                return
            if isinstance(spec, dict) and spec.get("format") in ("json", "xml") and isinstance(spec.get("fields"), dict):
                self.kind = f"fields-{spec['format']}"
                self.fields = {str(k): str(v) for k, v in spec["fields"].items()}
        elif filename.endswith(".json"):
            import jsonschema

            try:
                spec = json.loads(data)
                cls = jsonschema.validators.validator_for(spec)
                self.validator = cls(spec, format_checker=cls.FORMAT_CHECKER)
                self.kind = "json"
            except (ValueError, jsonschema.SchemaError):
                self.kind = None
        elif filename.endswith(".xsd"):
            self.kind = "xml"

    def _check_fields(self, doc: dict) -> dict:
        missing = sorted(set(self.fields) - set(doc))
        extra = sorted(set(doc) - set(self.fields))
        if missing:
            return {"ok": False, "detail": f"doesn't match {self.schema}: missing field(s) {', '.join(missing)}"}
        if extra:
            return {"ok": False, "detail": f"doesn't match {self.schema}: unknown field(s) {', '.join(extra)}"}
        for name, kind in self.fields.items():
            if err := _field_error(kind, doc[name]):
                return {"ok": False, "detail": f"doesn't match {self.schema}: {name}: {err}"}
        return {"ok": True, "detail": f"matches {self.schema}"}

    def check(self, value: bytes | None) -> dict:
        if value is None:
            return {"ok": False, "detail": "empty message (tombstone)"}
        if self.kind == "fields-json":
            try:
                doc = json.loads(value)
            except ValueError as e:
                return {"ok": False, "detail": f"not JSON: {e}"}
            if not isinstance(doc, dict):
                return {"ok": False, "detail": f"doesn't match {self.schema}: expected a JSON object"}
            return self._check_fields(doc)
        if self.kind == "fields-xml":
            try:
                root = ET.fromstring(value)
            except ET.ParseError as e:
                return {"ok": False, "detail": f"not well-formed XML: {e}"}
            return self._check_fields({child.tag: (child.text or "") for child in root})
        if self.kind == "json":
            try:
                doc = json.loads(value)
            except ValueError as e:
                return {"ok": False, "detail": f"not JSON: {e}"}
            errors = sorted(self.validator.iter_errors(doc), key=lambda e: list(e.path))
            if errors:
                where = "/".join(str(p) for p in errors[0].path) or "(root)"
                return {"ok": False, "detail": f"doesn't match {self.schema}: {where}: {errors[0].message}"}
            return {"ok": True, "detail": f"matches {self.schema}"}
        if self.kind == "xml":
            try:
                ET.fromstring(value)
            except ET.ParseError as e:
                return {"ok": False, "detail": f"not well-formed XML: {e}"}
            return {"ok": True, "detail": f"well-formed XML ({self.schema}; not validated against the XSD)"}
        return {"ok": None, "detail": "no schema check"}


def _iso(ms: int | None) -> str | None:
    if not ms or ms <= 0:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _preview(value: bytes | None) -> tuple[str | None, bool, str]:
    if value is None:
        return None, False, "none"
    clipped = value[:PREVIEW_BYTES]
    try:
        return clipped.decode("utf-8"), len(value) > PREVIEW_BYTES, "text"
    except UnicodeDecodeError:
        return base64.b64encode(clipped).decode(), len(value) > PREVIEW_BYTES, "base64"


def message_event(partition: int, offset: int, ts_ms: int | None, key: bytes | None, value: bytes | None,
                  checker: FormatChecker) -> dict:
    text, truncated, encoding = _preview(value)
    return {
        "type": "message", "partition": partition, "offset": offset, "timestamp": _iso(ts_ms),
        "key": _preview(key)[0], "value": text, "encoding": encoding, "truncated": truncated,
        "size": len(value) if value is not None else 0, "check": checker.check(value),
    }


async def kafka_feed(cfg: dict, topic: str, checker: FormatChecker, stop: asyncio.Event,
                     history: int = HISTORY) -> AsyncIterator[dict]:
    """Read-only feed of a Kafka topic (blocking client in a thread, events through a queue)."""
    from confluent_kafka import Consumer, KafkaError, KafkaException, TopicPartition

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    halt = threading.Event()

    last_error: list[str | None] = [None]

    def emit(event: dict):
        def put():
            if not queue.full():
                queue.put_nowait(event)
        try:
            loop.call_soon_threadsafe(put)
        except RuntimeError:
            pass  # the feed was closed and its loop is gone

    def report(message: str):
        if message != last_error[0]:
            last_error[0] = message
            emit({"type": "status", "state": "error", "message": message})

    def on_error(err):
        # Transport problems (brokers down, bad credentials) arrive here, from poll().
        # librdkafka keeps retrying, so the feed recovers by itself once they're fixed.
        report(err.str())

    def worker():
        consumer = None
        try:
            consumer = Consumer({**cfg, "error_cb": on_error, "logger": log})
            md = None
            while md is None and not halt.is_set():
                try:
                    md = consumer.list_topics(topic, timeout=5)
                except KafkaException as e:
                    consumer.poll(0.2)  # serve error_cb: it has the specific reason (e.g. auth failed)
                    err = e.args[0] if e.args else None
                    report(last_error[0] or (err.str() if hasattr(err, "str") else str(e)))
            if md is None:
                return
            tmd = md.topics.get(topic)
            if tmd is None or tmd.error is not None:
                reason = tmd.error.str() if tmd is not None and tmd.error else "not found"
                emit({"type": "status", "state": "error", "message": f"topic {topic!r}: {reason}"})
                return
            partitions = sorted(tmd.partitions)
            per = max(1, math.ceil(history / max(1, len(partitions))))
            assignment, end_total = [], 0
            for p in partitions:
                low, high = consumer.get_watermark_offsets(TopicPartition(topic, p), timeout=10)
                end_total += high
                assignment.append(TopicPartition(topic, p, max(low, high - per)))
            consumer.assign(assignment)  # no subscribe(): no group membership, no rebalance
            last_error[0] = None
            emit({"type": "status", "state": "live", "partitions": len(partitions), "endOffsets": end_total,
                  "message": f"{len(partitions)} partition(s); showing the last {per} per partition, then new messages"})
            while not halt.is_set():
                msg = consumer.poll(0.5)
                if msg is None:
                    continue
                if msg.error():
                    if msg.error().code() != KafkaError._PARTITION_EOF:
                        report(msg.error().str())
                    continue
                if last_error[0] is not None:  # recovered
                    last_error[0] = None
                    emit({"type": "status", "state": "live", "message": "receiving again"})
                ts_type, ts = msg.timestamp()
                emit(message_event(msg.partition(), msg.offset(), ts, msg.key(), msg.value(), checker))
        except KafkaException as e:
            emit({"type": "status", "state": "error", "message": str(e.args[0].str() if e.args else e)})
        except Exception as e:  # never let a peek take the server down
            emit({"type": "status", "state": "error", "message": f"{type(e).__name__}: {e}"})
        finally:
            if consumer is not None:
                consumer.close()  # no commits were made; closing just drops the connection
            emit({"type": "_done"})

    thread = threading.Thread(target=worker, name=f"peek-{topic}", daemon=True)
    yield {"type": "status", "state": "connecting", "message": f"connecting to {cfg['bootstrap.servers']}"}
    thread.start()
    try:
        while not stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=1)
            except asyncio.TimeoutError:
                continue
            if event["type"] == "_done":
                break
            yield event
    finally:
        halt.set()


# --------------------------------------------------------------------------- #
# Demo mode: there's no Kafka, so make up plausible traffic (flagged as demo).
#
# Every topic carries the same record stream: record n has the same guid (also the
# Kafka key, as foundry-schemas' Schema::key does) on every topic, rendered in that
# topic's schema and a little later the further downstream it is. Every 7th record's
# data isn't UTF-8 text, so a Packets topic doesn't carry it, the way Base64Decoder
# drops it. That lets the UI pair a processor's input and output records.
# --------------------------------------------------------------------------- #

DEMO_EPOCH = 1_790_000_000.0
DEMO_INTERVAL = 1.5
DEMO_STAGE_DELAY = {"XmlPackets": 0.0, "Packets": 0.25, "EnrichedPackets": 0.5}
_TEXTS = ["Hello, world!", "ping", "temperature=21.5", "door opened", "heartbeat"]


def demo_record(n: int) -> dict:
    rnd = random.Random(n)
    data = bytes(rnd.getrandbits(8) | 0x80 for _ in range(6)) if n % 7 == 3 else rnd.choice(_TEXTS).encode()
    produced = DEMO_EPOCH + n * DEMO_INTERVAL
    return {
        "guid": str(uuid.UUID(int=rnd.getrandbits(128), version=4)),
        "data": data,
        "time_sent": datetime.fromtimestamp(produced, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "host_ip": f"10.0.4.{rnd.randint(2, 250)}",
        "target_ip": f"2001:db8::{rnd.randint(1, 255):x}",
    }


def demo_value(schema: str | None, rec: dict) -> bytes | None:
    """Record n as it appears on a topic of this schema, or None if the topic doesn't carry it.

    As in PacketPipeline: XML in, JSON with the payload still base64 (Packets), then the payload
    decoded and an ISP added (EnrichedPackets)."""
    encoded = base64.b64encode(rec["data"]).decode()
    if schema == "XmlPackets":
        return (f"<xml_packets><guid>{rec['guid']}</guid><data>{encoded}</data><time_sent>{rec['time_sent']}</time_sent>"
                f"<host_ip>{rec['host_ip']}</host_ip><target_ip>{rec['target_ip']}</target_ip></xml_packets>").encode()
    doc = {"guid": rec["guid"], "data": encoded}
    if schema == "EnrichedPackets":
        try:
            doc["data"] = rec["data"].decode("utf-8")
        except UnicodeDecodeError:
            return None  # dropped by the decoder
        doc["ISP"] = "Example ISP" if rec["host_ip"].endswith(("2", "4", "6", "8")) else "unknown"
    doc.update(time_sent=rec["time_sent"], host_ip=rec["host_ip"], target_ip=rec["target_ip"])
    return json.dumps(doc, separators=(",", ":")).encode()


async def demo_feed(schema: str | None, topic: str, checker: FormatChecker, stop: asyncio.Event,
                    history: int = 6, interval: float = DEMO_INTERVAL) -> AsyncIterator[dict]:
    yield {"type": "status", "state": "live", "partitions": 3, "demo": True,
           "message": "demo mode: generated sample messages, not a real topic"}
    delay = DEMO_STAGE_DELAY.get(schema or "", 0.0)
    scale = interval / DEMO_INTERVAL  # tests run the clock faster

    def due(n: int) -> float:
        return DEMO_EPOCH + (n * DEMO_INTERVAL + delay) * scale

    def emit(n: int) -> dict | None:
        rec = demo_record(n)
        value = demo_value(schema, rec)
        if value is None:
            return None
        return message_event(n % 3, n // 3, int(due(n) * 1000), rec["guid"].encode(), value, checker)

    now = time.time()
    n = int((now - DEMO_EPOCH) / (DEMO_INTERVAL * scale))
    while due(n) > now:
        n -= 1
    for i in range(n - history + 1, n + 1):
        if (e := emit(i)) is not None:
            yield e
    while not stop.is_set():
        n += 1
        try:
            await asyncio.wait_for(stop.wait(), timeout=max(0.0, due(n) - time.time()))
            break
        except asyncio.TimeoutError:
            pass
        if (e := emit(n)) is not None:
            yield e
