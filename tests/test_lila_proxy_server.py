import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lila_proxy_server


class LilaProxyServerTests(unittest.TestCase):
    def test_rotation_cycle(self):
        lila_proxy_server.provider_rotation_index = 0

        first = lila_proxy_server.get_next_provider()
        second = lila_proxy_server.get_next_provider()
        third = lila_proxy_server.get_next_provider()
        fourth = lila_proxy_server.get_next_provider()

        self.assertEqual(first["name"], "gemini")
        self.assertEqual(second["name"], "groq")
        self.assertEqual(third["name"], "deepseek")
        self.assertEqual(fourth["name"], "gemini")


if __name__ == "__main__":
    unittest.main()
