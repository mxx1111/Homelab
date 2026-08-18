import os
import pytest
from unittest.mock import patch, MagicMock
from backend.notify import Notifier


def test_serverchan_default_enabled_from_key():
    cfg = {"notify": {"sendkey": "sctp1234tXYZ"}}
    notifier = Notifier(cfg)
    assert notifier.enabled is True
    assert notifier.provider == "serverchan"
    assert notifier.sendkey == "sctp1234tXYZ"


def test_serverchan_disabled_when_empty():
    cfg = {"notify": {}}
    notifier = Notifier(cfg)
    assert notifier.enabled is False


def test_serverchan_explicit_disabled():
    cfg = {"notify": {"enabled": False, "sendkey": "sctp1234tXYZ"}}
    notifier = Notifier(cfg)
    assert notifier.enabled is False


def test_ntfy_provider_from_cfg():
    cfg = {
        "notify": {
            "provider": "ntfy",
            "url": "https://ntfy.sh/my-secret-topic",
            "token": "tk_123"
        }
    }
    notifier = Notifier(cfg)
    assert notifier.enabled is True
    assert notifier.provider == "ntfy"
    assert notifier.ntfy_url == "https://ntfy.sh/my-secret-topic"
    assert notifier.ntfy_token == "tk_123"


def test_ntfy_provider_from_env(monkeypatch):
    monkeypatch.setenv("HOMELAB_NTFY_URL", "https://ntfy.example.com/alerts")
    monkeypatch.setenv("HOMELAB_NTFY_TOKEN", "secret-token")
    cfg = {"notify": {"provider": "ntfy"}}
    notifier = Notifier(cfg)
    assert notifier.enabled is True
    assert notifier.ntfy_url == "https://ntfy.example.com/alerts"
    assert notifier.ntfy_token == "secret-token"


def test_should_send():
    cfg = {"notify": {"sendkey": "sctp123", "min_level": "warn"}}
    notifier = Notifier(cfg)
    assert notifier.should_send("info") is False
    assert notifier.should_send("warn") is True
    assert notifier.should_send("crit") is True


@patch("httpx.post")
def test_send_ntfy_success(mock_post):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_post.return_value = mock_resp

    cfg = {
        "notify": {
            "provider": "ntfy",
            "url": "https://ntfy.sh/my-topic",
            "token": "secret"
        }
    }
    notifier = Notifier(cfg)
    err = notifier.send("Test Title", "Test Body")
    assert err is None
    mock_post.assert_called_once()
    args, kwargs = mock_post.call_args
    assert args[0] == "https://ntfy.sh/my-topic"
    assert kwargs["content"] == b"Test Body"
    assert kwargs["headers"]["Title"] == "Test Title".encode("utf-8")
    assert kwargs["headers"]["Authorization"] == "Bearer secret"


@patch("httpx.post")
def test_send_ntfy_http_error(mock_post):
    mock_resp = MagicMock()
    mock_resp.status_code = 404
    mock_resp.text = "Topic not found"
    mock_post.return_value = mock_resp

    cfg = {
        "notify": {
            "provider": "ntfy",
            "url": "https://ntfy.sh/my-topic"
        }
    }
    notifier = Notifier(cfg)
    err = notifier.send("Test Title", "Test Body")
    assert "HTTP 404" in err
