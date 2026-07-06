"""Make the ml/ packages importable under pytest without an editable install."""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
