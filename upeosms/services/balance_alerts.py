import json
import re

import frappe
from frappe import _

from upeosms.api.sms import _format_ke_mobile

SETTINGS = "UPEOSMS Settings"


class BalanceAlertSettings:
	"""Who is told when the SMS balance runs low, and at which levels.

	Stored on UPEOSMS Settings so each site sets its own levels and numbers.
	"""

	MAX_RECIPIENTS = 10
	MAX_THRESHOLDS = 10

	def __init__(self, doc=None):
		self.doc = doc or frappe.get_single(SETTINGS)

	@property
	def enabled(self) -> bool:
		return bool(self.doc.low_balance_alerts_enabled)

	@property
	def thresholds(self) -> list[int]:
		return self.parse_thresholds(self.doc.low_balance_thresholds)

	@property
	def recipients(self) -> list[str]:
		return self.parse_numbers(self.doc.low_balance_recipients)

	@property
	def alerted(self) -> set[int]:
		try:
			return {int(t) for t in json.loads(self.doc.alerted_thresholds or "[]")}
		except (TypeError, ValueError):
			return set()

	def as_dict(self) -> dict:
		return {
			"enabled": self.enabled,
			"thresholds": self.thresholds,
			"recipients": self.recipients,
			"balance": self.doc.last_known_balance,
			"checked_on": self.doc.balance_checked_on,
		}

	def save(self, enabled, thresholds, recipients) -> dict:
		if not frappe.has_permission(SETTINGS, "write"):
			frappe.throw(_("You are not allowed to change SMS settings."), frappe.PermissionError)
		levels = self.parse_thresholds(thresholds, strict=True)
		numbers = self.parse_numbers(recipients, strict=True)
		enabled = frappe.utils.cint(enabled)
		if enabled and not levels:
			frappe.throw(_("Add at least one balance level to be alerted at."))
		if enabled and not numbers:
			frappe.throw(_("Add at least one phone number to alert."))
		self.doc.low_balance_alerts_enabled = enabled
		self.doc.low_balance_thresholds = ", ".join(str(t) for t in levels)
		self.doc.low_balance_recipients = "\n".join(numbers)
		self.doc.save()
		return self.as_dict()

	def record_check(self, balance: float, alerted: set[int]):
		# Written straight to the stored values: this runs from the scheduler and
		# must not bump the settings' modified time or trip over someone editing it.
		values = {
			"last_known_balance": balance,
			"balance_checked_on": frappe.utils.now(),
			"alerted_thresholds": json.dumps(sorted(alerted, reverse=True)),
		}
		frappe.db.set_single_value(SETTINGS, values, update_modified=False)
		self.doc.update(values)

	@classmethod
	def parse_thresholds(cls, value, strict: bool = False) -> list[int]:
		items = value if isinstance(value, list) else re.split(r"[\s,;]+", str(value or ""))
		levels = set()
		for item in items:
			if str(item).strip() == "":
				continue
			try:
				level = int(float(item))
			except (TypeError, ValueError):
				if strict:
					frappe.throw(_("{0} is not a number.").format(item))
				continue
			if level <= 0:
				if strict:
					frappe.throw(_("Balance levels must be above zero."))
				continue
			levels.add(level)
		if strict and len(levels) > cls.MAX_THRESHOLDS:
			frappe.throw(_("Use {0} balance levels or fewer.").format(cls.MAX_THRESHOLDS))
		return sorted(levels, reverse=True)

	@classmethod
	def parse_numbers(cls, value, strict: bool = False) -> list[str]:
		items = value if isinstance(value, list) else re.split(r"[\s,;]+", str(value or ""))
		numbers = []
		for item in items:
			item = str(item).strip()
			if not item:
				continue
			try:
				_format_ke_mobile(item)
			except ValueError:
				if strict:
					frappe.throw(_("{0} is not a valid Kenyan mobile number.").format(item))
				continue
			if item not in numbers:
				numbers.append(item)
		if strict and len(numbers) > cls.MAX_RECIPIENTS:
			frappe.throw(_("Alert {0} numbers or fewer.").format(cls.MAX_RECIPIENTS))
		return numbers
