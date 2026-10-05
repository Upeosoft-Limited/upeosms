import frappe
from frappe import _

from upeosms.services.balance_alerts import BalanceAlertSettings
from upeosms.services.message_composer import MessageComposer
from upeosms.services.quick_send import QuickSend
from upeosms.services.sender_profile import SenderProfile
from upeosms.services.sms_account import TextSmsAccount


class LowBalanceMonitor:
	"""Checks the SMS balance and texts the chosen people when it falls to a set level.

	Each level alerts once. A level re-arms when the balance is back above it,
	so after a top-up the next fall alerts again.
	"""

	def __init__(self, account, settings: BalanceAlertSettings, notify):
		self.account = account
		self.settings = settings
		self.notify = notify

	def check(self) -> dict:
		balance = self.account.balance()
		alerted = {level for level in self.settings.alerted if balance <= level}
		crossed = [level for level in self.settings.thresholds if balance <= level and level not in alerted]
		alert = None
		if crossed and self.settings.enabled and self.settings.recipients:
			# One message for the lowest level reached, even if several were passed at once.
			alert = self.notify(self.settings.recipients, self.message(balance, min(crossed)))
			if any(r.get("status") == "Sent" for r in alert.get("results", [])):
				alerted |= set(crossed)
		self.settings.record_check(balance, alerted)
		return {"balance": balance, "alert": alert, "alerted": sorted(alerted, reverse=True)}

	@staticmethod
	def message(balance: float, level: int) -> str:
		site = frappe.db.get_single_value("Website Settings", "app_name") or frappe.local.site
		return _(
			"{0}: SMS balance is down to {1} units, below {2}. Please top up the TextSMS account soon."
		).format(site, f"{balance:,.0f}", f"{level:,}")


def send_alert(numbers: list[str], message: str) -> dict:
	"""Send the alert as its own small campaign, so it shows in History and Messages."""
	return QuickSend(
		"\n".join(numbers),
		message,
		MessageComposer(""),  # an alert to staff, not a church message: no signature
		campaign_title=_("Low balance alert"),
	).send()


def build_monitor() -> LowBalanceMonitor:
	return LowBalanceMonitor(TextSmsAccount(), BalanceAlertSettings(), send_alert)


def scheduled_check():
	"""Scheduler entry point. Sites without a TextSMS account are skipped quietly."""
	if SenderProfile.for_current_site().source == SenderProfile.MISSING:
		return
	try:
		build_monitor().check()
	except Exception:
		frappe.log_error(title="UPEOSMS balance check failed")
