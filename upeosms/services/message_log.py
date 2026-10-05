import re

import frappe


class MessageLog:
	"""Every message sent from the console, newest first, searchable by number or name.

	Reads SMS Recipient (one row per person per campaign, with its latest result),
	which is what the desk SMS Recipient and SMS Send Log lists showed.
	"""

	PAGE_SIZE = 30
	STATUSES = ("Sent", "Failed", "Pending", "Queued", "Processing")

	def __init__(self, search: str | None = None, status: str | None = None):
		self.search = (search or "").strip()
		self.status = status if status in self.STATUSES else None

	def page(self, start: int = 0) -> dict:
		filters = {"status": self.status} if self.status else {}
		rows = frappe.get_all(
			"SMS Recipient",
			filters=filters,
			or_filters=self._search_filters(),
			fields=[
				"name",
				"campaign",
				"mobile",
				"recipient_name",
				"status",
				"rendered_message",
				"error_message",
				"sent_on",
				"modified",
			],
			order_by="modified desc",
			start=max(int(start or 0), 0),
			page_length=self.PAGE_SIZE + 1,
		)
		self._attach_campaign_names(rows)
		for row in rows:
			lines = (row.error_message or "").strip().splitlines()
			row.error_message = lines[-1] if lines else None
		return {"messages": rows[: self.PAGE_SIZE], "has_more": len(rows) > self.PAGE_SIZE}

	def _search_filters(self) -> dict | None:
		if not self.search:
			return None
		like = f"%{self.search}%"
		filters = {"recipient_name": ["like", like], "mobile": ["like", like]}
		# Numbers are stored as typed (07..., 254..., +254...), so also match the
		# last nine digits, which every Kenyan format shares.
		digits = re.sub(r"\D", "", self.search)
		if len(digits) >= 9:
			filters["name"] = ["in", self._names_by_local_number(digits[-9:])]
		return filters

	@staticmethod
	def _names_by_local_number(local: str) -> list[str]:
		return frappe.get_all("SMS Recipient", filters={"mobile": ["like", f"%{local}"]}, pluck="name") or [
			""
		]

	@staticmethod
	def _attach_campaign_names(rows):
		names = {r.campaign for r in rows if r.campaign}
		titles = dict(
			frappe.get_all(
				"SMS Campaign",
				filters={"name": ["in", list(names) or [""]]},
				fields=["name", "campaign_name"],
				as_list=True,
			)
		)
		for row in rows:
			row.campaign_title = titles.get(row.campaign) or row.campaign
