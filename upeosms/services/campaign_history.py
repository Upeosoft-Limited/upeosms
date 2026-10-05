import frappe

LIST_FIELDS = (
	"name",
	"campaign_name",
	"status",
	"total_recipients",
	"sent_count",
	"failed_count",
	"creation",
)


class CampaignHistory:
	"""Searchable, paged list of past campaigns for the console."""

	PAGE_SIZE = 20
	STATUSES = ("Draft", "Ready", "Queued", "Sending", "Completed", "Completed with Errors", "Failed")

	def __init__(self, search: str | None = None, status: str | None = None):
		self.search = (search or "").strip()
		self.status = status if status in self.STATUSES else None

	def page(self, start: int = 0) -> dict:
		filters = {"status": self.status} if self.status else {}
		or_filters = (
			{"campaign_name": ["like", f"%{self.search}%"], "name": ["like", f"%{self.search}%"]}
			if self.search
			else None
		)
		rows = frappe.get_all(
			"SMS Campaign",
			filters=filters,
			or_filters=or_filters,
			fields=list(LIST_FIELDS),
			order_by="creation desc",
			start=max(int(start or 0), 0),
			page_length=self.PAGE_SIZE + 1,
		)
		return {"campaigns": rows[: self.PAGE_SIZE], "has_more": len(rows) > self.PAGE_SIZE}
