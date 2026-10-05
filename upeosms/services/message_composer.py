import frappe

from upeosms.utils.template import render_message


class MessageComposer:
	"""Turns a template and a recipient's row into the exact SMS text sent,
	including the signature set in UPEOSMS Settings."""

	def __init__(self, signature: str | None = None):
		self.signature = (signature or "").strip()

	@classmethod
	def from_settings(cls) -> "MessageComposer":
		return cls(frappe.db.get_single_value("UPEOSMS Settings", "sms_signature"))

	def compose(self, template: str, row: dict | None = None) -> str:
		return self.sign(render_message(template or "", row or {}))

	def sign(self, message: str) -> str:
		message = (message or "").rstrip()
		# Already signed by hand: don't sign twice.
		if not self.signature or not message or message.endswith(self.signature):
			return message
		# A blank line sets the signature apart from the message.
		return f"{message}\n\n{self.signature}"
