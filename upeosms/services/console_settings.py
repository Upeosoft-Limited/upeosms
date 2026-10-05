import frappe
from frappe import _

SETTINGS = "UPEOSMS Settings"


class ConsoleSettings:
	"""The settings people change from the SMS console instead of the desk form."""

	MAX_SIGNATURE = 100
	MAX_LINES = 3

	def save_signature(self, signature: str | None) -> str:
		if not frappe.has_permission(SETTINGS, "write"):
			frappe.throw(_("You are not allowed to change SMS settings."), frappe.PermissionError)
		signature = self.tidy(signature)
		if len(signature) > self.MAX_SIGNATURE:
			frappe.throw(_("Keep the signature to {0} characters or fewer.").format(self.MAX_SIGNATURE))
		if signature.count("\n") >= self.MAX_LINES:
			frappe.throw(_("Keep the signature to {0} lines or fewer.").format(self.MAX_LINES))
		settings = frappe.get_single(SETTINGS)
		settings.sms_signature = signature
		settings.save()
		return signature

	@staticmethod
	def tidy(signature: str | None) -> str:
		"""Collapse spaces within each line and drop blank lines, keeping line breaks."""
		lines = (" ".join(line.split()) for line in (signature or "").splitlines())
		return "\n".join(line for line in lines if line)

	@staticmethod
	def organisation_name() -> str:
		return frappe.db.get_single_value("Website Settings", "app_name") or ""
