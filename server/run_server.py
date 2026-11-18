"""Entry point for the bundled desktop backend."""
import os

import uvicorn

import main

if __name__ == "__main__":
    uvicorn.run(main.app, host="127.0.0.1", port=int(os.environ.get("VT_PORT", "8010")), log_level="warning")
