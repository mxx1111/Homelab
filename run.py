"""启动入口。监听地址从 config.yaml 读取"""
import uvicorn

from backend.config import get

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=get("server.host", "0.0.0.0"),
        port=int(get("server.port", 8770)),
        log_level="info",
        access_log=False,
    )
