from . import (certs, connections, containers, crowdsec, disks, engine, host,
               network, ports, remote, services, storage)

# key 需与 config.yaml 的 intervals 对应
REGISTRY = {
    "host": host.collect,
    "network": network.collect,
    "containers": containers.collect,
    "services": services.collect,
    "crowdsec": crowdsec.collect,
    "storage": storage.collect,
    "certs": certs.collect,
    "remote": remote.collect,
    "ports": ports.collect,
    "connections": connections.collect,
    "engine": engine.collect,
    "disks": disks.collect,
}

__all__ = ["REGISTRY"]
