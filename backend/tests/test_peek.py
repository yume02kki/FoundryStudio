"""Live dataset feed: config parity with the processor runtime, schema checks, the demo
stream, and (when a broker is available) a real Kafka topic.

The Kafka tests run when STUDIO_TEST_KAFKA is set, e.g.
STUDIO_TEST_KAFKA=127.0.0.1:19092 STUDIO_TEST_KAFKA_SASL=127.0.0.1:19093 (SCRAM-SHA-512 user
peeker / s3cret-pw).
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest
from fastapi.testclient import TestClient

from foundry_studio.app import create_app
from foundry_studio import demo
from foundry_studio.manifest import manifest_to_graph
from foundry_studio.peek import (
    PeekError, TypeChecker, bind, client_config, demo_feed, demo_record, demo_value, kafka_feed,
)


PACKET = {"guid": "3f2b8c1e-9a4d-4e7b-8f21-6c0d5a9e4b17", "data": "Hello, world!", "time_sent": "2026-10-01T14:32:05.123Z",
          "host_ip": "10.0.4.17", "target_ip": "2001:db8::42"}
XML = (b"<packet><guid>3f2b8c1e-9a4d-4e7b-8f21-6c0d5a9e4b17</guid><data>SGVsbG8=</data>"
       b"<time_sent>2026-10-01T14:32:05.123Z</time_sent><host_ip>10.0.4.17</host_ip><target_ip>2001:db8::42</target_ip></packet>")


def secrets(tmp_path, name="kafka-creds", user="peeker", password="s3cret-pw"):
    d = tmp_path / "secrets" / name
    d.mkdir(parents=True)
    (d / "username").write_text(user + "\n")
    (d / "password").write_text(password + "\n")
    return tmp_path / "secrets"


def test_client_config_mirrors_the_runtime(tmp_path):
    cfg = client_config({
        "Brokers": "upstream-kafka:9092", "SecurityProtocol": "SASL_SSL", "SaslMechanism": "SCRAM-SHA-512",
        "SecretRef": "kafka-creds", "ConsumerGroup": "swpipeline", "ssl.ca.location": "/etc/ca.pem",
    }, secrets(tmp_path))
    assert cfg["bootstrap.servers"] == "upstream-kafka:9092"
    assert cfg["security.protocol"] == "sasl_ssl"
    assert (cfg["sasl.mechanism"], cfg["sasl.username"], cfg["sasl.password"]) == ("SCRAM-SHA-512", "peeker", "s3cret-pw")
    assert cfg["ssl.ca.location"] == "/etc/ca.pem"
    # Never the pipeline's group, never commits.
    assert cfg["group.id"].startswith("foundry-studio-peek-") and "swpipeline" not in cfg["group.id"]
    assert cfg["enable.auto.commit"] == "false"


@pytest.mark.parametrize("settings, message", [
    ({}, "no Brokers"),
    ({"Brokers": "b:9092", "Timeout": "5"}, "unknown connection setting 'Timeout'"),
    ({"Brokers": "b:9092", "SecurityProtocol": "SASL_SSL", "SecretRef": "x"}, "needs a SaslMechanism"),
    ({"Brokers": "b:9092", "SecurityProtocol": "SASL_SSL", "SaslMechanism": "PLAIN"}, "needs a SecretRef"),
    ({"Brokers": "b:9092", "SecurityProtocol": "SASL_SSL", "SaslMechanism": "PLAIN", "SecretRef": "missing"},
     "FOUNDRY_SECRETS_DIR/missing/username"),
])
def test_client_config_errors(settings, message, tmp_path):
    with pytest.raises(PeekError, match=message.replace("(", r"\(")):
        client_config(settings, tmp_path)


def test_bind_uses_this_environments_cluster(tmp_path):
    from foundry_studio.config import load_clusters

    f = tmp_path / "watcher.yaml"
    f.write_text("repo: x\nclusters:\n  - match: upstream-kafka:9092\n    bootstrap: kafka:19092\n"
                 "    connection: {Brokers: \"localhost:9092\", SecurityProtocol: PLAINTEXT}\n")
    clusters = load_clusters(f)
    manifest = {"Brokers": "upstream-kafka:9092", "SecurityProtocol": "SASL_SSL", "SaslMechanism": "SCRAM-SHA-512",
                "SecretRef": "upstream-kafka-creds", "ConsumerGroup": "swpipeline"}
    assert bind(manifest, clusters) == {"Brokers": "localhost:9092", "SecurityProtocol": "PLAINTEXT"}
    cfg = client_config(bind(manifest, clusters), tmp_path)
    assert cfg["bootstrap.servers"] == "localhost:9092" and "sasl.username" not in cfg
    assert bind({"Brokers": "elsewhere:9092"}, clusters) == {"Brokers": "elsewhere:9092"}


def test_type_checks():
    """A message is one of the Kafka's AllowedTypes when its foundry-type header says so."""
    checker = TypeChecker(["DecodeEnrichment", "IspEnrichment"])
    assert checker.label == "DecodeEnrichment | IspEnrichment"
    assert checker.check(b"{}", [("foundry-type", b"IspEnrichment")]) == {"ok": True, "detail": "IspEnrichment"}
    assert checker.check(b"{}", [("foundry-type", b"Packets")]) == {
        "ok": False, "detail": "Packets, but the Kafka allows DecodeEnrichment, IspEnrichment"}
    assert checker.check(b"{}", None)["ok"] is None
    assert checker.check(None)["ok"] is False


@pytest.mark.anyio
async def test_demo_feed_stamps_its_types():
    for name in ("XmlPackets", "Packets", "EnrichedPackets"):
        stop = asyncio.Event()
        events = []
        async for e in demo_feed(name, "t", TypeChecker([name]), stop, interval=0.01):
            events.append(e)
            if len(events) == 8:
                stop.set()
        msgs = [e for e in events if e["type"] == "message"]
        assert events[0]["demo"] and len(msgs) >= 5
        assert all(m["check"]["ok"] for m in msgs), [m["check"] for m in msgs]


def test_demo_records_line_up_across_topics():
    """Record n has the same key on every topic; the decoded topic drops non-UTF-8 data."""
    for n in range(14):
        rec = demo_record(n)
        xml, enc, dec = (demo_value(s, rec) for s in ("XmlPackets", "Packets", "EnrichedPackets"))
        assert rec["guid"] in xml.decode() and json.loads(enc)["guid"] == rec["guid"]
        if n % 7 == 3:
            assert dec is None
        else:
            assert json.loads(dec)["data"] == rec["data"].decode()


def test_peek_endpoint_streams_demo_data_and_stops_on_disconnect(services):
    import socket
    import threading
    import time

    import httpx
    import uvicorn

    app = create_app(services, start_watcher=False)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                           timeout_graceful_shutdown=5))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.05)
    graph = manifest_to_graph(demo.MANIFEST)
    base = f"http://127.0.0.1:{port}"
    try:
        assert httpx.post(f"{base}/api/peek", json={"graph": graph, "node": "Nope"}).status_code == 400
        events = []
        with httpx.stream("POST", f"{base}/api/peek", json={"graph": graph, "node": "XmlToJson"}, timeout=10) as r:
            assert r.headers["content-type"].startswith("text/event-stream")
            for line in r.iter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
                if len(events) >= 5:
                    break
        assert events[0] == {"type": "endpoint", "endpoint": "dataset:ConvertedPackets", "dataset": "ConvertedPackets",
                             "topic": "enrichment.packets", "schema": "Packets", "cluster": "kafka/prod"}
        assert events[1]["state"] == "live"
        assert all(e["check"] == {"ok": True, "detail": "Packets"} for e in events[2:])
        # Closing the stream releases the feed (the semaphore slot comes back).
        deadline = time.time() + 10
        while services.peeks._value != 8 and time.time() < deadline:
            time.sleep(0.1)
        assert services.peeks._value == 8
    finally:
        server.should_exit = True
        thread.join(10)
    assert not thread.is_alive()


# --------------------------------------------------------------------------- #
# Against a real broker
# --------------------------------------------------------------------------- #

KAFKA = os.environ.get("STUDIO_TEST_KAFKA")
KAFKA_SASL = os.environ.get("STUDIO_TEST_KAFKA_SASL")
needs_kafka = pytest.mark.skipif(not KAFKA, reason="set STUDIO_TEST_KAFKA to a broker to run")


def make_topic(partitions=3) -> str:
    from confluent_kafka.admin import AdminClient, NewTopic

    topic = f"peek-test-{uuid.uuid4().hex[:8]}"
    admin = AdminClient({"bootstrap.servers": KAFKA})
    admin.create_topics([NewTopic(topic, partitions, 1)])[topic].result(15)
    return topic


def produce(topic, values):
    from confluent_kafka import Producer

    p = Producer({"bootstrap.servers": KAFKA})
    for i, v in enumerate(values):
        p.produce(topic, v, key=str(i).encode(), partition=i % 3)
    p.flush(15)


async def collect(feed, until, timeout=30):
    events = []

    async def run():
        async for e in feed:
            events.append(e)
            if until(events):
                return

    await asyncio.wait_for(run(), timeout)
    return events


@needs_kafka
@pytest.mark.anyio
async def test_kafka_feed_history_then_live_without_touching_groups(tmp_path):
    from confluent_kafka import Consumer, TopicPartition
    from confluent_kafka.admin import AdminClient

    topic = make_topic()
    produce(topic, [XML] * 29 + [b"<packet>broken"])
    # The pipeline's own consumer group has committed offsets that must not move.
    group = f"pipeline-{uuid.uuid4().hex[:6]}"
    c = Consumer({"bootstrap.servers": KAFKA, "group.id": group, "enable.auto.commit": "false"})
    c.commit(offsets=[TopicPartition(topic, p, 2) for p in range(3)], asynchronous=False)
    c.close()

    brokers, protocol = (KAFKA_SASL, "SASL_PLAINTEXT") if KAFKA_SASL else (KAFKA, "PLAINTEXT")
    settings = {"Brokers": brokers, "SecurityProtocol": protocol, "ConsumerGroup": group}
    if KAFKA_SASL:
        settings |= {"SaslMechanism": "SCRAM-SHA-512", "SecretRef": "kafka-creds"}
    cfg = client_config(settings, secrets(tmp_path))
    checker = TypeChecker(["XmlPackets"])
    stop = asyncio.Event()
    feed = kafka_feed(cfg, topic, checker, stop, history=9)

    events = await collect(feed, lambda ev: sum(e["type"] == "message" for e in ev) >= 9)
    status = [e for e in events if e["type"] == "status"]
    assert [s["state"] for s in status] == ["connecting", "live"] and status[1]["partitions"] == 3
    history = [e for e in events if e["type"] == "message"]
    assert len(history) == 9  # 3 most recent per partition
    assert all(m["check"]["ok"] is None for m in history)  # no foundry-type header

    produce(topic, [b"<packet>new</packet>"])
    events = await collect(feed, lambda ev: any(e["type"] == "message" for e in ev))
    assert next(e for e in events if e["type"] == "message")["value"] == "<packet>new</packet>"
    stop.set()
    await feed.aclose()

    admin = AdminClient({"bootstrap.servers": KAFKA})
    groups = [g.group_id for g in admin.list_consumer_groups().result(10).valid]
    assert not any(g.startswith("foundry-studio-peek-") for g in groups)
    c = Consumer({"bootstrap.servers": KAFKA, "group.id": group})
    assert [tp.offset for tp in c.committed([TopicPartition(topic, p) for p in range(3)], timeout=10)] == [2, 2, 2]
    c.close()


@needs_kafka
@pytest.mark.anyio
async def test_kafka_feed_reports_bad_credentials_and_unreachable_brokers(tmp_path):
    stop = asyncio.Event()
    if KAFKA_SASL:
        cfg = client_config({"Brokers": KAFKA_SASL, "SecurityProtocol": "SASL_PLAINTEXT",
                             "SaslMechanism": "SCRAM-SHA-512", "SecretRef": "kafka-creds"},
                            secrets(tmp_path, password="wrong"))
        feed = kafka_feed(cfg, make_topic(), TypeChecker([]), stop)
        events = await collect(feed, lambda ev: any(e.get("state") == "error" for e in ev))
        assert "authentication" in next(e for e in events if e.get("state") == "error")["message"].lower()
        stop.set()
        await feed.aclose()

    stop = asyncio.Event()
    cfg = client_config({"Brokers": "127.0.0.1:1"}, tmp_path)
    feed = kafka_feed(cfg, "anything", TypeChecker([]), stop)
    events = await collect(feed, lambda ev: any(e.get("state") == "error" for e in ev))
    assert any(e.get("state") == "error" for e in events)
    stop.set()
    await feed.aclose()
