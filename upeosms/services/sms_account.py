import frappe
import requests
from frappe import _

from upeosms.api.sms import _get_textsms_config

DEFAULT_BALANCE_URL = "https://sms.textsms.co.ke/api/services/getbalance/"


class TextSmsAccount:
	"""The site's TextSMS account, for questions other than sending."""

	def __init__(self, config: dict | None = None, post=requests.post):
		self.config = config or _get_textsms_config()
		self._post = post

	def balance(self) -> float:
		"""Credit left on the account, in SMS units."""
		conf = frappe.get_conf()
		r = self._post(
			conf.get("textsms_balance_url") or DEFAULT_BALANCE_URL,
			json={"apikey": self.config["api_key"], "partnerID": self.config["partner_id"]},
			timeout=self.config.get("timeout") or 15,
		)
		r.raise_for_status()
		data = r.json()
		if str(data.get("response-code")) != "200" or data.get("credit") is None:
			raise frappe.ValidationError(
				_("TextSMS did not return a balance: {0}").format(data.get("response-description") or data)
			)
		return float(data["credit"])
