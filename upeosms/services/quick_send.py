import json
import re

import frappe
from frappe import _

from upeosms.api.sms import _format_ke_mobile
from upeosms.services.message_composer import MessageComposer
from upeosms.tasks import process_campaign
from upeosms.utils.template import extract_variables


class QuickSend:
	"""Send one message to a few typed-in numbers, without an upload file.

	It is recorded as a small campaign so the messages appear in the usual
	campaign history and SMS Send Log. It runs in the request, not the queue,
	so the person sees each number's result straight away; the limit keeps
	that request short.
	"""

	LIMIT = 10
	SEPARATORS = re.compile(r"[\s,;]+")

	def __init__(
		self, numbers: str, message: str, composer: MessageComposer, campaign_title: str | None = None
	):
		self.numbers = self._parse_numbers(numbers)
		self.template = (message or "").strip()
		self.composer = composer
		self.campaign_title = campaign_title

	def send(self) -> dict:
		self._validate()
		campaign = self._create_campaign()
		process_campaign(campaign.name)
		return {"campaign": campaign.name, "results": self._results(campaign.name)}

	def _parse_numbers(self, numbers: str) -> list[str]:
		seen = []
		for number in self.SEPARATORS.split(numbers or ""):
			if number and number not in seen:
				seen.append(number)
		return seen

	def _validate(self):
		if not self.numbers:
			frappe.throw(_("Enter at least one phone number."))
		if len(self.numbers) > self.LIMIT:
			frappe.throw(
				_("A test send is limited to {0} numbers. Upload a file to send to more.").format(self.LIMIT)
			)
		invalid = [n for n in self.numbers if not self._is_valid(n)]
		if invalid:
			frappe.throw(_("These are not valid Kenyan mobile numbers: {0}").format(", ".join(invalid)))
		if not self.template:
			frappe.throw(_("Type the message to send."))
		variables = extract_variables(self.template)
		if variables:
			frappe.throw(
				_("A test send has no file to fill {0} from. Remove it, or upload a file.").format(
					", ".join("{" + v + "}" for v in variables)
				)
			)

	@staticmethod
	def _is_valid(number: str) -> bool:
		try:
			_format_ke_mobile(number)
		except ValueError:
			return False
		return True

	def _create_campaign(self):
		message = self.composer.compose(self.template)
		campaign = frappe.get_doc(
			{
				"doctype": "SMS Campaign",
				"campaign_name": self._campaign_name(),
				"message_template": self.template,
				"status": "Queued",
				"total_recipients": len(self.numbers),
				"started_on": frappe.utils.now(),
			}
		).insert(ignore_permissions=True)

		for idx, number in enumerate(self.numbers, start=1):
			frappe.get_doc(
				{
					"doctype": "SMS Recipient",
					"campaign": campaign.name,
					"row_index": idx,
					"mobile": number,
					"row_data_json": json.dumps({"mobile": number}),
					"rendered_message": message,
					"status": "Pending",
					"retry_count": 0,
				}
			).insert(ignore_permissions=True)

		frappe.db.commit()
		return campaign

	def _campaign_name(self) -> str:
		stamp = frappe.utils.now_datetime().strftime("%d %b %Y %H:%M")
		return f"{self.campaign_title or _('Test send')} {stamp}"

	@staticmethod
	def _results(campaign_name: str) -> list[dict]:
		return frappe.get_all(
			"SMS Recipient",
			filters={"campaign": campaign_name},
			fields=["mobile", "status", "error_message"],
			order_by="row_index asc",
		)
