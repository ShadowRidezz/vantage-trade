import os
import tempfile

# Tests never write uploads, frames or databases into the project folder.
_tmp = tempfile.mkdtemp(prefix="vt-test-")
os.environ.setdefault("VT_DATA_DIR", _tmp)
os.environ.setdefault("DATABASE_URL", "sqlite:///" + os.path.join(_tmp, "test.db"))
os.environ.setdefault("VT_NO_TRADER", "1")
