from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from upeosms.api import page
from upeosms.services.balance_alerts import BalanceAlertSettings
from upeosms.services.balance_monitor import LowBalanceMonitor, scheduled_check
from upeosms.services.campaign_history import CampaignHistory
from upeosms.services.campaign_report import CampaignReport
from upeosms.services.campaign_retry import CampaignRetry
from upeosms.services.console_settings import ConsoleSettings
from upeosms.services.desk_icon import DeskIconBranding
from upeosms.services.message_composer import MessageComposer
from upeosms.services.message_log import MessageLog
from upeosms.services.quick_send import QuickSend
from upeosms.services.sample_file import SampleRecipientFile
from upeosms.services.sender_profile import SenderProfile
from upeosms.services.sms_account import TextSmsAccount
from upeosms.utils.file_parser import _read_xlsx

TEXTSMS_KEYS = {
	"textsms_api_key": "test-key",
	"textsms_partner_id": "1",
	"textsms_sender_id": "TESTSENDER",
}
TEXTSMS_OK = {"responses": [{"response-description": "Success", "response-code": 200, "messageid": "m1"}]}


class TestMessageComposer(IntegrationTestCase):
	def test_signs_after_a_blank_line(self):
		self.assertEqual(MessageComposer("KSF Kitengela").sign("Hello"), "Hello\n\nKSF Kitengela")

	def test_no_signature_leaves_message_alone(self):
		self.assertEqual(MessageComposer("").sign("Hello  "), "Hello")

	def test_does_not_sign_twice(self):
		self.assertEqual(MessageComposer("KSF").sign("Thanks\nKSF"), "Thanks\nKSF")
		self.assertEqual(MessageComposer("KSF").sign("Thanks\n\nKSF"), "Thanks\n\nKSF")

	def test_empty_message_stays_empty(self):
		self.assertEqual(MessageComposer("KSF").sign(""), "")

	def test_compose_fills_variables_then_signs(self):
		self.assertEqual(MessageComposer("KSF").compose("Hi {name}", {"name": "Jane"}), "Hi Jane\n\nKSF")

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
		self.assertEqual(post.call_args.args[1]["message"], "Test message\n\nKSF Test")
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
		self.assertEqual(preview[0]["message"], "Hi Jane\n\nKSF Test")

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


class TestConsoleSettings(IntegrationTestCase):
	def tearDown(self):
		frappe.db.set_single_value("UPEOSMS Settings", "sms_signature", None)

	def test_saves_tidied_signature(self):
		self.assertEqual(ConsoleSettings().save_signature("  KSF   Kitengela "), "KSF Kitengela")
		self.assertEqual(MessageComposer.from_settings().signature, "KSF Kitengela")

	def test_keeps_line_breaks_and_drops_blank_lines(self):
		saved = ConsoleSettings().save_signature("God bless you,\n\n  KSF  Kitengela \n")
		self.assertEqual(saved, "God bless you,\nKSF Kitengela")
		self.assertEqual(
			MessageComposer.from_settings().sign("Hello"), "Hello\n\nGod bless you,\nKSF Kitengela"
		)

	def test_rejects_too_many_lines(self):
		with self.assertRaises(frappe.ValidationError):
			ConsoleSettings().save_signature("a\nb\nc\nd")

	def test_empty_clears_signature(self):
		ConsoleSettings().save_signature("KSF")
		self.assertEqual(ConsoleSettings().save_signature(""), "")
		self.assertEqual(MessageComposer.from_settings().signature, "")

	def test_rejects_long_signature(self):
		with self.assertRaises(frappe.ValidationError):
			ConsoleSettings().save_signature("x" * (ConsoleSettings.MAX_SIGNATURE + 1))

	def test_needs_settings_write_permission(self):
		with self.set_user("Guest"), self.assertRaises(frappe.PermissionError):
			ConsoleSettings().save_signature("KSF")


class TestCampaignReport(IntegrationTestCase):
	def setUp(self):
		self.campaign = frappe.get_doc(
			{"doctype": "SMS Campaign", "campaign_name": "Report test", "status": "Completed with Errors"}
		).insert(ignore_permissions=True)
		statuses = ["Sent"] * 3 + ["Failed"] + ["Pending"]
		for idx, status in enumerate(statuses, start=1):
			frappe.get_doc(
				{
					"doctype": "SMS Recipient",
					"campaign": self.campaign.name,
					"row_index": idx,
					"mobile": f"07000000{idx:02d}",
					"status": status,
					"error_message": "Traceback (most recent call last):\nValueError: Invalid Kenyan mobile number"
					if status == "Failed"
					else None,
				}
			).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.db.delete("SMS Recipient", {"campaign": self.campaign.name})
		frappe.db.delete("SMS Campaign", {"name": self.campaign.name})

	def test_counts_by_status(self):
		report = CampaignReport(self.campaign.name).as_dict()
		self.assertEqual(report["counts"], {"Sent": 3, "Failed": 1, "Pending": 1})
		self.assertEqual(len(report["recipients"]), 5)

	def test_filters_and_shows_last_error_line(self):
		report = CampaignReport(self.campaign.name).as_dict(status="Failed")
		self.assertEqual([r.status for r in report["recipients"]], ["Failed"])
		self.assertEqual(report["recipients"][0].error_message, "ValueError: Invalid Kenyan mobile number")

	def test_unknown_filter_shows_everyone(self):
		self.assertEqual(len(CampaignReport(self.campaign.name).as_dict(status="Nope")["recipients"]), 5)

	def test_pages(self):
		with patch.object(CampaignReport, "PAGE_SIZE", 2):
			report = CampaignReport(self.campaign.name)
			self.assertEqual(
				[r.mobile for r in report.as_dict(start=2)["recipients"]], ["0700000003", "0700000004"]
			)

	def test_missing_campaign(self):
		with self.assertRaises(frappe.DoesNotExistError):
			CampaignReport("no-such-campaign")

	def test_endpoint_refuses_guests(self):
		with self.set_user("Guest"), self.assertRaises(frappe.PermissionError):
			page.get_campaign_detail(self.campaign.name)

	def test_results_export_lists_every_recipient(self):
		from io import BytesIO

		from openpyxl import load_workbook

		report = CampaignReport(self.campaign.name)
		sheet = load_workbook(BytesIO(report.results_xlsx())).active
		rows = list(sheet.iter_rows(values_only=True))
		self.assertEqual(rows[0][:3], ("Mobile", "Name", "Status"))
		self.assertEqual(len(rows), 6)
		self.assertEqual(rows[4][4], "ValueError: Invalid Kenyan mobile number")
		self.assertEqual(report.results_filename, "report_test_results.xlsx")


class TestCampaignRetry(IntegrationTestCase):
	def setUp(self):
		self.campaign = frappe.get_doc(
			{"doctype": "SMS Campaign", "campaign_name": "Retry test", "status": "Completed with Errors"}
		).insert(ignore_permissions=True)
		for idx, status in enumerate(["Sent", "Failed", "Failed"], start=1):
			frappe.get_doc(
				{
					"doctype": "SMS Recipient",
					"campaign": self.campaign.name,
					"row_index": idx,
					"mobile": "0712345678",
					"status": status,
					"error_message": "boom" if status == "Failed" else None,
				}
			).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.db.delete("SMS Recipient", {"campaign": self.campaign.name})
		frappe.db.delete("SMS Campaign", {"name": self.campaign.name})
		frappe.db.commit()

	def test_requeues_only_failed(self):
		with patch("upeosms.services.campaign_retry.enqueue_campaign_send") as enqueue:
			self.assertEqual(CampaignRetry(self.campaign.name).run(), 2)
		enqueue.assert_called_once_with(self.campaign.name)
		statuses = frappe.get_all("SMS Recipient", {"campaign": self.campaign.name}, pluck="status")
		self.assertEqual(sorted(statuses), ["Pending", "Pending", "Sent"])
		self.assertEqual(frappe.db.get_value("SMS Campaign", self.campaign.name, "status"), "Queued")

	def test_refuses_while_sending(self):
		self.campaign.db_set("status", "Sending")
		with patch("upeosms.services.campaign_retry.enqueue_campaign_send") as enqueue:
			with self.assertRaises(frappe.ValidationError):
				CampaignRetry(self.campaign.name).run()
		enqueue.assert_not_called()

	def test_refuses_when_nothing_failed(self):
		frappe.db.set_value("SMS Recipient", {"campaign": self.campaign.name}, "status", "Sent")
		with self.assertRaises(frappe.ValidationError):
			CampaignRetry(self.campaign.name).run()


class TestCampaignHistory(IntegrationTestCase):
	def setUp(self):
		self.names = [
			frappe.get_doc({"doctype": "SMS Campaign", "campaign_name": name, "status": status})
			.insert(ignore_permissions=True)
			.name
			for name, status in (("History alpha", "Completed"), ("History beta", "Failed"))
		]

	def tearDown(self):
		frappe.db.delete("SMS Campaign", {"name": ["in", self.names]})

	def test_search_and_status(self):
		names = [c.campaign_name for c in CampaignHistory("History").page()["campaigns"]]
		self.assertIn("History alpha", names)
		self.assertIn("History beta", names)
		failed = [c.campaign_name for c in CampaignHistory("History", "Failed").page()["campaigns"]]
		self.assertEqual(failed, ["History beta"])

	def test_unknown_status_is_ignored(self):
		self.assertEqual(len(CampaignHistory("History", "Bogus").page()["campaigns"]), 2)

	def test_has_more(self):
		with patch.object(CampaignHistory, "PAGE_SIZE", 1):
			page_one = CampaignHistory("History").page()
		self.assertEqual(len(page_one["campaigns"]), 1)
		self.assertTrue(page_one["has_more"])


class TestMessageLog(IntegrationTestCase):
	def setUp(self):
		self.campaign = frappe.get_doc(
			{"doctype": "SMS Campaign", "campaign_name": "Message log test", "status": "Completed"}
		).insert(ignore_permissions=True)
		for idx, (mobile, name, status) in enumerate(
			[("0712345678", "Grace Njeri", "Sent"), ("254799888777", "Peter Kamau", "Failed")], start=1
		):
			frappe.get_doc(
				{
					"doctype": "SMS Recipient",
					"campaign": self.campaign.name,
					"row_index": idx,
					"mobile": mobile,
					"recipient_name": name,
					"status": status,
					"rendered_message": f"Hello {name}",
				}
			).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.db.delete("SMS Recipient", {"campaign": self.campaign.name})
		frappe.db.delete("SMS Campaign", {"name": self.campaign.name})

	def _mobiles(self, search=None, status=None):
		rows = MessageLog(search, status).page()["messages"]
		return [r.mobile for r in rows if r.campaign == self.campaign.name]

	def test_search_by_name(self):
		self.assertEqual(self._mobiles("Grace"), ["0712345678"])

	def test_search_by_number_in_another_format(self):
		self.assertEqual(self._mobiles("+254 712 345 678"), ["0712345678"])
		self.assertEqual(self._mobiles("0799888777"), ["254799888777"])

	def test_status_filter(self):
		self.assertEqual(self._mobiles("Peter", "Failed"), ["254799888777"])
		self.assertEqual(self._mobiles("Peter", "Sent"), [])

	def test_carries_campaign_title(self):
		row = next(r for r in MessageLog("Grace").page()["messages"] if r.campaign == self.campaign.name)
		self.assertEqual(row.campaign_title, "Message log test")

	def test_endpoint_refuses_guests(self):
		with self.set_user("Guest"), self.assertRaises(frappe.PermissionError):
			page.get_messages()


class TestDeskIconBranding(IntegrationTestCase):
	def setUp(self):
		if not frappe.db.exists("Desktop Icon", "UPEO SMS"):
			self.skipTest("Site has no UPEO SMS desktop icon")
		self.before = frappe.db.get_value("Desktop Icon", "UPEO SMS", "logo_url")

	def tearDown(self):
		frappe.db.set_value("Desktop Icon", "UPEO SMS", "logo_url", self.before)

	def test_sets_logo_once(self):
		branding = DeskIconBranding("UPEO SMS", "/assets/upeosms/images/upeosms-icon.svg")
		branding.apply()
		self.assertEqual(
			frappe.db.get_value("Desktop Icon", "UPEO SMS", "logo_url"),
			"/assets/upeosms/images/upeosms-icon.svg",
		)
		self.assertFalse(branding.apply())

	def test_missing_icon_is_ignored(self):
		self.assertFalse(DeskIconBranding("No such tile", "/x.svg").apply())


class FakeAccount:
	def __init__(self, *balances):
		self.balances = list(balances)

	def balance(self):
		return self.balances.pop(0)


class FakeNotifier:
	def __init__(self, status="Sent"):
		self.calls = []
		self.status = status

	def __call__(self, numbers, message):
		self.calls.append((numbers, message))
		return {"campaign": "x", "results": [{"mobile": n, "status": self.status} for n in numbers]}


ALERT_FIELDS = (
	"low_balance_alerts_enabled",
	"low_balance_thresholds",
	"low_balance_recipients",
	"last_known_balance",
	"balance_checked_on",
	"alerted_thresholds",
)


class BalanceTestCase(IntegrationTestCase):
	def setUp(self):
		self.saved = {f: frappe.db.get_single_value("UPEOSMS Settings", f) for f in ALERT_FIELDS}
		frappe.db.set_single_value(
			"UPEOSMS Settings",
			{
				"low_balance_alerts_enabled": 1,
				"low_balance_thresholds": "500, 100, 50",
				"low_balance_recipients": "0758502428\n0710568273",
				"alerted_thresholds": "[]",
			},
		)

	def tearDown(self):
		frappe.db.set_single_value("UPEOSMS Settings", self.saved)

	def run_checks(self, *balances, notifier=None):
		notifier = notifier or FakeNotifier()
		account = FakeAccount(*balances)
		results = [LowBalanceMonitor(account, BalanceAlertSettings(), notifier).check() for _ in balances]
		return notifier, results


class TestLowBalanceMonitor(BalanceTestCase):
	def test_no_alert_above_all_levels(self):
		notifier, _ = self.run_checks(1984)
		self.assertEqual(notifier.calls, [])
		self.assertEqual(frappe.db.get_single_value("UPEOSMS Settings", "last_known_balance"), 1984)

	def test_each_level_alerts_once(self):
		notifier, _ = self.run_checks(600, 480, 470, 90, 85, 40)
		messages = [m for _, m in notifier.calls]
		self.assertEqual(len(messages), 3)
		self.assertIn("below 500", messages[0])
		self.assertIn("below 100", messages[1])
		self.assertIn("below 50", messages[2])
		self.assertEqual(notifier.calls[0][0], ["0758502428", "0710568273"])

	def test_several_levels_at_once_send_one_alert_for_the_lowest(self):
		notifier, results = self.run_checks(40)
		self.assertEqual(len(notifier.calls), 1)
		self.assertIn("below 50", notifier.calls[0][1])
		self.assertEqual(results[0]["alerted"], [500, 100, 50])

	def test_top_up_rearms_levels(self):
		notifier, _ = self.run_checks(450, 2000, 450)
		self.assertEqual(len(notifier.calls), 2)

	def test_disabled_sends_nothing_then_alerts_when_enabled(self):
		frappe.db.set_single_value("UPEOSMS Settings", "low_balance_alerts_enabled", 0)
		notifier, _ = self.run_checks(80)
		self.assertEqual(notifier.calls, [])
		frappe.db.set_single_value("UPEOSMS Settings", "low_balance_alerts_enabled", 1)
		notifier, _ = self.run_checks(80)
		self.assertEqual(len(notifier.calls), 1)

	def test_failed_alert_is_retried(self):
		notifier, _ = self.run_checks(450, 450, notifier=FakeNotifier(status="Failed"))
		self.assertEqual(len(notifier.calls), 2)

	def test_message_is_one_sms(self):
		message = LowBalanceMonitor.message(1234.0, 500)
		self.assertIn("1,234 units", message)
		self.assertLessEqual(len(message), 160)

	def test_alert_is_sent_unsigned_as_its_own_campaign(self):
		from upeosms.services.balance_monitor import send_alert

		frappe.db.set_single_value("UPEOSMS Settings", "sms_signature", "KSF Test")
		self.addCleanup(frappe.db.set_single_value, "UPEOSMS Settings", "sms_signature", None)
		with (
			patch.dict(frappe.local.conf, TEXTSMS_KEYS),
			patch("upeosms.api.sms._post", return_value=TEXTSMS_OK) as post,
		):
			result = send_alert(["0758502428"], "Balance low")
		self.addCleanup(self.delete_campaign, result["campaign"])
		self.assertEqual(post.call_args.args[1]["message"], "Balance low")
		title = frappe.db.get_value("SMS Campaign", result["campaign"], "campaign_name")
		self.assertTrue(title.startswith("Low balance alert"))

	@staticmethod
	def delete_campaign(name):
		# send_alert commits, so its rows outlive the test transaction.
		for doctype in ("SMS Send Log", "SMS Recipient"):
			frappe.db.delete(doctype, {"campaign": name})
		frappe.db.delete("SMS Campaign", {"name": name})
		frappe.db.commit()


class TestBalanceAlertSettings(BalanceTestCase):
	def test_saves_sorted_levels_and_numbers(self):
		r = BalanceAlertSettings().save(1, "50, 500 100;100", "0758502428, 0710568273")
		self.assertEqual(r["thresholds"], [500, 100, 50])
		self.assertEqual(r["recipients"], ["0758502428", "0710568273"])

	def test_rejects_bad_input(self):
		for thresholds, recipients in (
			("abc", "0758502428"),
			("-5", "0758502428"),
			("500", "12345"),
			("", "0758502428"),
			("500", ""),
		):
			with (
				self.subTest(thresholds=thresholds, recipients=recipients),
				self.assertRaises(frappe.ValidationError),
			):
				BalanceAlertSettings().save(1, thresholds, recipients)

	def test_can_turn_off_with_empty_lists(self):
		self.assertFalse(BalanceAlertSettings().save(0, "", "")["enabled"])

	def test_needs_permission(self):
		with self.set_user("Guest"), self.assertRaises(frappe.PermissionError):
			BalanceAlertSettings().save(1, "500", "0758502428")


class FakeResponse:
	def __init__(self, data):
		self.data = data

	def raise_for_status(self):
		pass

	def json(self):
		return self.data


def replying(data):
	"""A stand-in for requests.post that always answers with data."""

	def post(url, json, timeout):
		return FakeResponse(data)

	return post


class TestTextSmsAccount(IntegrationTestCase):
	def account(self, reply):
		return TextSmsAccount({"api_key": "k", "partner_id": "1", "timeout": 5}, post=replying(reply))

	def test_reads_credit(self):
		self.assertEqual(self.account({"response-code": 200, "credit": "1984.00"}).balance(), 1984.0)

	def test_error_response_raises(self):
		with self.assertRaises(frappe.ValidationError):
			self.account({"response-code": 1004, "response-description": "Invalid key"}).balance()


class TestScheduledCheck(IntegrationTestCase):
	def test_skips_site_without_account(self):
		with (
			patch("upeosms.services.balance_monitor.build_monitor") as build,
			patch.object(SenderProfile, "for_current_site", return_value=SenderProfile({}, {})),
		):
			scheduled_check()
		build.assert_not_called()

	def test_endpoints_refuse_guests(self):
		with self.set_user("Guest"):
			for call in (lambda: page.save_balance_alerts(1, "500", "0758502428"), page.check_balance_now):
				with self.assertRaises(frappe.PermissionError):
					call()
