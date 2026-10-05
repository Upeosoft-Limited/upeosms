import frappe
from frappe.utils.xlsxutils import make_xlsx

CAMPAIGN_FIELDS = (
	"name",
	"campaign_name",
	"status",
	"message_template",
	"total_recipients",
	"sent_count",
	"failed_count",
	"queued_count",
	"progress_percent",
	"started_on",
	"completed_on",
	"creation",
)


class CampaignReport:
	"""One campaign's numbers and a page of its recipients, for the console."""

	PAGE_SIZE = 50
	STATUSES = ("Sent", "Failed", "Pending", "Queued", "Processing")

	def __init__(self, campaign_name: str):
		self.campaign = frappe.db.get_value("SMS Campaign", campaign_name, CAMPAIGN_FIELDS, as_dict=True)
		if not self.campaign:
			frappe.throw(frappe._("Campaign {0} not found.").format(campaign_name), frappe.DoesNotExistError)

	def as_dict(self, status: str | None = None, start: int = 0) -> dict:
		filters = {"campaign": self.campaign.name}
		if status in self.STATUSES:
			filters["status"] = status
		recipients = frappe.get_all(
			"SMS Recipient",
			filters=filters,
			fields=["mobile", "recipient_name", "status", "rendered_message", "error_message", "sent_on"],
			order_by="row_index asc",
			start=max(int(start or 0), 0),
			page_length=self.PAGE_SIZE,
		)
		for row in recipients:
			# Tracebacks are stored whole; the last line is the part a person can act on.
			lines = (row.error_message or "").strip().splitlines()
			row.error_message = lines[-1] if lines else None
		return {
			"campaign": self.campaign,
			"counts": self._counts(),
			"recipients": recipients,
			"page_size": self.PAGE_SIZE,
		}

	def _counts(self) -> dict:
		rows = frappe.get_all(
			"SMS Recipient",
			filters={"campaign": self.campaign.name},
			fields=["status", {"COUNT": "*", "as": "n"}],
			group_by="status",
		)
		return {row.status: row.n for row in rows}

	def results_xlsx(self) -> bytes:
		rows = frappe.get_all(
			"SMS Recipient",
			filters={"campaign": self.campaign.name},
			fields=["mobile", "recipient_name", "status", "sent_on", "error_message", "rendered_message"],
			order_by="row_index asc",
		)
		data = [["Mobile", "Name", "Status", "Sent on", "Error", "Message"]]
		for row in rows:
			lines = (row.error_message or "").strip().splitlines()
			data.append(
				[
					row.mobile,
					row.recipient_name,
					row.status,
					row.sent_on,
					lines[-1] if lines else "",
					row.rendered_message,
				]
			)
		return make_xlsx(data, "Results").getvalue()

	@property
	def results_filename(self) -> str:
		return f"{frappe.scrub(self.campaign.campaign_name or self.campaign.name)}_results.xlsx"
