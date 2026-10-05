# Copyright (c) 2026, Karani Geoffrey and contributors
# For license information, please see license.txt

from frappe.model.document import Document

from upeosms.services.sender_profile import SenderProfile


class UPEOSMSSettings(Document):
	def onload(self):
		# The sender ID lives in site_config.json, not in this doctype, so it is
		# shown read-only rather than stored as a field.
		self.set_onload("sender", SenderProfile.for_current_site().as_dict())
