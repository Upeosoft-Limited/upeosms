import frappe

from upeosms.api.sms import _get_textsms_conf_source


class SenderProfile:
	"""Which TextSMS sender ID this site sends as, and whose account it is."""

	OWN = "own"
	SHARED = "shared"
	MISSING = "missing"

	def __init__(self, conf: dict, site_conf: dict):
		self._conf = conf
		self._site_conf = site_conf

	@classmethod
	def for_current_site(cls) -> "SenderProfile":
		return cls(
			_get_textsms_conf_source(),
			frappe.get_file_json(frappe.get_site_path("site_config.json")),
		)

	@property
	def sender_id(self) -> str | None:
		return self._conf.get("textsms_sender_id")

	@property
	def source(self) -> str:
		"""OWN when the keys live in this site's config, SHARED when they are
		inherited from the bench-wide config another site may also use."""
		if not self.sender_id:
			return self.MISSING
		if self._site_conf.get("textsms_sender_id"):
			return self.OWN
		return self.SHARED

	def as_dict(self) -> dict:
		return {"sender_id": self.sender_id, "source": self.source}
