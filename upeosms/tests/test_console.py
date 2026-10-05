from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from upeosms.api import page
from upeosms.services.message_composer import MessageComposer
from upeosms.services.quick_send import QuickSend
from upeosms.services.sample_file import SampleRecipientFile
from upeosms.services.sender_profile import SenderProfile
from upeosms.utils.file_parser import _read_xlsx

TEXTSMS_KEYS = {
	"textsms_api_key": "test-key",
	"textsms_partner_id": "1",
	"textsms_sender_id": "TESTSENDER",
}
TEXTSMS_OK = {"responses": [{"response-description": "Success", "response-code": 200, "messageid": "m1"}]}


class TestMessageComposer(IntegrationTestCase):
	def test_signs_on_its_own_line(self):
		self.assertEqual(MessageComposer("KSF Kitengela").sign("Hello"), "Hello\nKSF Kitengela")

	def test_no_signature_leaves_message_alone(self):
		self.assertEqual(MessageComposer("").sign("Hello  "), "Hello")

	def test_does_not_sign_twice(self):
		self.assertEqual(MessageComposer("KSF").sign("Thanks\nKSF"), "Thanks\nKSF")

	def test_empty_message_stays_empty(self):
		self.assertEqual(MessageComposer("KSF").sign(""), "")

	def test_compose_fills_variables_then_signs(self):
		self.assertEqual(MessageComposer("KSF").compose("Hi {name}", {"name": "Jane"}), "Hi Jane\nKSF")

	def test_reads_signature_from_settings(self):
		frappe.db.set_single_value("UPEOSMS Settings", "sms_signature", "From Settings")
		self.assertEqual(MessageComposer.from_settings().signature, "From Settings")


class TestSenderProfile(IntegrationTestCase):
	def test_own_keys(self):
		profile = SenderProfile(TEXTSMS_KEYS, TEXTSMS_KEYS)
		self.assertEqual(profile.as_dict(), {"sender_id": "TESTSENDER", "source": "own"})

	def test_inherited_keys_are_shared(self):
		self.assertEqual(SenderProfile(TEXTSMS_KEYS, {}).source, SenderProfile.SHARED)

	def test_no_keys_is_missing(self):
		self.assertEqual(SenderProfile({}, {}).source, SenderProfile.MISSING)


class TestSampleRecipientFile(IntegrationTestCase):
	def test_sample_reads_back_as_valid_upload(self):
		path = frappe.get_site_path("private", "files", "usms_sample_test.xlsx")
		with open(path, "wb") as f:
			f.write(SampleRecipientFile().as_xlsx())
		self.addCleanup(lambda: __import__("os").remove(path))

		rows, columns = _read_xlsx(path)

		self.assertEqual(columns, ["mobile", "name", "amount"])
		self.assertEqual(rows[0]["mobile"], "0712345678")
		self.assertEqual(len(rows), len(SampleRecipientFile.ROWS))


class TestQuickSend(IntegrationTestCase):
	def setUp(self):
		frappe.db.set_single_value("UPEOSMS Settings", "sms_signature", "KSF Test")
		self.before = set(frappe.get_all("SMS Campaign", pluck="name"))

	def tearDown(self):
		for name in set(frappe.get_all("SMS Campaign", pluck="name")) - self.before:
			frappe.db.delete("SMS Send Log", {"campaign": name})
			frappe.db.delete("SMS Recipient", {"campaign": name})
			frappe.db.delete("SMS Campaign", {"name": name})
		frappe.db.set_single_value("UPEOSMS Settings", "sms_signature", None)
		frappe.db.commit()

	def _send(self, numbers, message="Test message"):
		return QuickSend(numbers, message, MessageComposer.from_settings()).send()

	def test_sends_signed_message_to_each_number(self):
		with (
			patch.dict(frappe.local.conf, TEXTSMS_KEYS),
			patch("upeosms.api.sms._post", return_value=TEXTSMS_OK) as post,
		):
			result = self._send("0712345678, 0798765432\n0712345678")

		self.assertEqual([r.status for r in result["results"]], ["Sent", "Sent"])
		self.assertEqual(post.call_count, 2)
		self.assertEqual(post.call_args.args[1]["message"], "Test message\nKSF Test")
		self.assertEqual(frappe.db.count("SMS Send Log", {"campaign": result["campaign"]}), 2)
		self.assertEqual(frappe.db.get_value("SMS Campaign", result["campaign"], "status"), "Completed")

	def test_reports_provider_failure_per_number(self):
		failed = {"responses": [{"response-description": "Invalid sender id", "response-code": 1001}]}
		with patch.dict(frappe.local.conf, TEXTSMS_KEYS), patch("upeosms.api.sms._post", return_value=failed):
			result = self._send("0712345678")

		self.assertEqual(result["results"][0].status, "Failed")
		self.assertIn("Invalid sender id", result["results"][0].error_message)

	def test_rejects_bad_input_before_sending(self):
		cases = [
			("", "Test"),
			("0712345678", ""),
			("12345", "Test"),
			("0712345678", "Hi {name}"),
			(" ".join(f"07123456{i:02d}" for i in range(QuickSend.LIMIT + 1)), "Test"),
		]
		with patch("upeosms.api.sms._post") as post:
			for numbers, message in cases:
				with (
					self.subTest(numbers=numbers, message=message),
					self.assertRaises(frappe.ValidationError),
				):
					self._send(numbers, message)
		post.assert_not_called()


class TestConsoleEndpoints(IntegrationTestCase):
	def test_preview_is_signed(self):
		frappe.db.set_single_value("UPEOSMS Settings", "sms_signature", "KSF Test")
		self.addCleanup(frappe.db.set_single_value, "UPEOSMS Settings", "sms_signature", None)
		preview = page._build_preview([{"mobile": "0712345678", "name": "Jane"}], "Hi {name}")
		self.assertEqual(preview[0]["message"], "Hi Jane\nKSF Test")

	def test_context_shows_sender_and_signature(self):
		with patch.dict(frappe.local.conf, TEXTSMS_KEYS):
			ctx = page.get_console_context()
		self.assertEqual(ctx["sender"]["sender_id"], "TESTSENDER")
		self.assertEqual(ctx["quick_send_limit"], QuickSend.LIMIT)

	def test_endpoints_refuse_users_who_cannot_run_campaigns(self):
		with self.set_user("Guest"), patch("upeosms.api.sms._post") as post:
			for call in (
				page.get_console_context,
				page.download_sample_file,
				lambda: page.quick_send("0712345678", "Hi"),
				lambda: page.get_campaign_progress_from_page("x"),
			):
				with self.assertRaises(frappe.PermissionError):
					call()
		post.assert_not_called()
