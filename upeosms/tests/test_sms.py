import json
import os
import tempfile
import unittest
from unittest.mock import patch

import frappe

from upeosms.api import sms

COMMON_KEYS = {
	"textsms_api_key": "common-key",
	"textsms_partner_id": "9830",
	"textsms_sender_id": "KSFTHIKARD",
}
SITE_KEYS = {
	"textsms_api_key": "site-key",
	"textsms_partner_id": "10463",
	"textsms_sender_id": "KSFKTENGELA",
}


class TestTextSMSConfig(unittest.TestCase):
	"""Which TextSMS account a site sends from."""

	def setUp(self):
		self.site_dir = tempfile.mkdtemp()

	def _config(self, merged, site_file):
		"""Resolve the config, given the merged conf and the site's own file."""
		with open(os.path.join(self.site_dir, "site_config.json"), "w") as f:
			json.dump(site_file, f)
		with (
			patch.object(frappe, "get_conf", return_value=frappe._dict(merged)),
			patch.object(frappe, "get_site_path", side_effect=lambda *p: os.path.join(self.site_dir, *p)),
		):
			return sms._get_textsms_config()

	def test_uses_merged_conf_by_default(self):
		cfg = self._config(COMMON_KEYS, {})
		self.assertEqual(cfg["partner_id"], "9830")
		self.assertEqual(cfg["sender_id"], "KSFTHIKARD")
		self.assertEqual(cfg["endpoint_url"], sms.DEFAULT_TEXTSMS_ENDPOINT)
		self.assertEqual(cfg["timeout"], 15)

	def test_missing_keys_raise(self):
		with self.assertRaises(frappe.ValidationError):
			self._config({}, {})

	def test_site_keys_only_uses_own_keys(self):
		site = {**SITE_KEYS, "textsms_site_keys_only": 1}
		cfg = self._config({**COMMON_KEYS, **site}, site)
		self.assertEqual(cfg["partner_id"], "10463")
		self.assertEqual(cfg["sender_id"], "KSFKTENGELA")

	def test_site_keys_only_never_falls_back_to_common(self):
		site = {"textsms_site_keys_only": 1}
		with self.assertRaises(frappe.ValidationError):
			self._config({**COMMON_KEYS, **site}, site)


class TestSendSMSAccess(unittest.TestCase):
	def test_send_sms_is_not_callable_over_http(self):
		self.assertNotIn(sms.send_sms, frappe.whitelisted)
		self.assertNotIn(sms.send_sms, frappe.guest_methods)
