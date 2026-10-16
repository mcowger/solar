import unittest

from release_notes import build_notes, tag_date


class ReleaseNotesTests(unittest.TestCase):
    def test_first_release_includes_all_dated_sections(self):
        changelog = "## [2026-10-16]\n\nNew\n\n## [2026-10-01]\n\nOld\n"
        notes = build_notes("2026.10.16", "ghcr.io/mcowger/solar", changelog, None)
        self.assertIn("New", notes)
        self.assertIn("Old", notes)
        self.assertIn("docker pull ghcr.io/mcowger/solar:2026.10.16", notes)

    def test_later_release_includes_only_new_sections(self):
        changelog = "## [2026-10-16]\n\nNew\n\n## [2026-10-01]\n\nOld\n"
        notes = build_notes("2026.10.16", "ghcr.io/mcowger/solar", changelog, "2026.10.01")
        self.assertIn("New", notes)
        self.assertNotIn("Old", notes)

    def test_invalid_tag_is_rejected(self):
        for invalid in ("v2026.10.16", "2026.13.01", "2026.10.16.foo"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                tag_date(invalid)


if __name__ == "__main__":
    unittest.main()
