import frappe
from frappe import _

SETTINGS = "UPEOSMS Settings"


class ConsoleSettings:
	"""The settings people change from the SMS console instead of the desk form."""

	MAX_SIGNATURE = 60

	def save_signature(self, signature: str | None) -> str:
		if not frappe.has_permission(SETTINGS, "write"):
			frappe.throw(_("You are not allowed to change SMS settings."), frappe.PermissionError)
		signature = " ".join((signature or "").split())
		if len(signature) > self.MAX_SIGNATURE:
			frappe.throw(_("Keep the signature to {0} characters or fewer.").format(self.MAX_SIGNATURE))
		settings = frappe.get_single(SETTINGS)
		settings.sms_signature = signature
		settings.save()
		return signature
