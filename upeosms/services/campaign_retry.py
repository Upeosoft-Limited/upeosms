import frappe
from frappe import _

from upeosms.tasks import enqueue_campaign_send


class CampaignRetry:
	"""Send again to the recipients a campaign failed to reach. Sent ones are left alone."""

	BUSY = ("Queued", "Sending")

	def __init__(self, campaign_name: str):
		self.campaign = frappe.get_doc("SMS Campaign", campaign_name)

	def run(self) -> int:
		if self.campaign.status in self.BUSY:
			frappe.throw(_("This campaign is still sending. Wait for it to finish."))
		failed = frappe.db.count("SMS Recipient", {"campaign": self.campaign.name, "status": "Failed"})
		if not failed:
			frappe.throw(_("There are no failed messages to send again."))

		frappe.db.set_value(
			"SMS Recipient",
			{"campaign": self.campaign.name, "status": "Failed"},
			{"status": "Pending", "error_message": None},
			update_modified=False,
		)
		self.campaign.db_set({"status": "Queued", "completed_on": None, "last_error": None})
		frappe.db.commit()
		enqueue_campaign_send(self.campaign.name)
		return failed
