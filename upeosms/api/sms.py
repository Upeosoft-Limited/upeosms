# ishi/api/sms.py
import re
from typing import Any, Dict, Optional

import frappe
import requests

# Default TextSMS endpoint (override in site_config.json if needed)
DEFAULT_TEXTSMS_ENDPOINT = "https://sms.textsms.co.ke/api/services/sendsms/"


# Deliberately NOT @frappe.whitelist. This was `allow_guest=True`, which let
# anyone on the internet send any text to any number on the site's TextSMS
# account. The only caller is server-side (upeosms.tasks), which needs no
# whitelist. Keep it that way.
def send_sms(mobile: str, message: str) -> Dict[str, Any]:
	"""
	Send an SMS via TextSMS. Server-side only.

	Reads config from site_config.json:
	  - textsms_api_key (required)
	  - textsms_partner_id (required)
	  - textsms_sender_id (required)
	  - textsms_endpoint_url (optional)
	  - textsms_timeout (optional, default 15)
	  - textsms_payload_mode (optional: "form" or "json"; default "form")

	Returns:
	  {
		ok: bool,
		status: str,
		message_id: str|None,
		mobile: str,
		cost: any,
		code: any,
		raw: dict|str|None,
		error: str|None
	  }
	"""
	try:
		msisdn = _format_ke_mobile(mobile)
		msg = (message or "").strip()
		if not msg:
			return {"ok": False, "error": "Empty message"}

		cfg = _get_textsms_config()

		payload = {
			"apikey": cfg["api_key"],
			"partnerID": cfg["partner_id"],
			"shortcode": cfg["sender_id"],
			"mobile": msisdn,
			"message": msg,
		}

		data = _post(cfg["endpoint_url"], payload, timeout=cfg["timeout"], mode=cfg["payload_mode"])
		return _parse_textsms_response(data, msisdn)

	except Exception as e:
		# Keep logs useful for debugging, but return a safe error to caller
		frappe.log_error(frappe.get_traceback(), "TextSMS send_sms failed")
		return {"ok": False, "error": str(e)}


def _get_textsms_config() -> Dict[str, Any]:
	"""
	Reads TextSMS config from site_config.json.

	Required:
	  - textsms_api_key (str)
	  - textsms_partner_id (int/str)
	  - textsms_sender_id (str)

	Optional:
	  - textsms_endpoint_url (str)
	  - textsms_timeout (int)
	  - textsms_payload_mode ("form" or "json")  -> default "form"
	  - textsms_site_keys_only (bool) - see _get_textsms_conf_source
	"""
	conf = _get_textsms_conf_source()

	cfg = {
		"api_key": conf.get("textsms_api_key"),
		"partner_id": conf.get("textsms_partner_id"),
		"sender_id": conf.get("textsms_sender_id"),
		"endpoint_url": conf.get("textsms_endpoint_url") or DEFAULT_TEXTSMS_ENDPOINT,
		"timeout": int(conf.get("textsms_timeout") or 15),
		"payload_mode": (conf.get("textsms_payload_mode") or "form").strip().lower(),
	}

	missing = [k for k in ("api_key", "partner_id", "sender_id") if not cfg.get(k)]
	if missing:
		raise frappe.ValidationError(
			"Missing TextSMS configuration in site_config.json: "
			+ ", ".join(f"textsms_{m}" for m in missing)
		)

	if cfg["payload_mode"] not in ("form", "json"):
		cfg["payload_mode"] = "form"

	return cfg


# Same guard as ksf.api.sms._get_textsms_conf_source. Duplicated because the
# two apps are installed independently and neither may import the other.
def _get_textsms_conf_source() -> dict[str, Any]:
	"""
	Return the config the TextSMS keys are read from.

	Normally that is frappe.get_conf(), which falls back to the bench-wide
	common_site_config.json, whose keys may belong to another site's account.
	A site with `textsms_site_keys_only` set reads the keys from its own
	site_config.json alone, so it fails instead of sending as someone else.
	"""
	conf = frappe.get_conf()
	if not conf.get("textsms_site_keys_only"):
		return conf
	return frappe.get_file_json(frappe.get_site_path("site_config.json"))


def _format_ke_mobile(mobile: Optional[str]) -> str:
	"""
	Normalize Kenyan mobile numbers to E.164: +254XXXXXXXXX.
	Accepts:
	  - 07XXXXXXXX, 01XXXXXXXX
	  - 7XXXXXXXX, 1XXXXXXXX
	  - 2547XXXXXXXX, 2541XXXXXXXX
	  - +2547XXXXXXXX, +2541XXXXXXXX
	"""
	digits = re.sub(r"\D", "", mobile or "")

	# Strip leading country code if present
	if digits.startswith("254"):
		digits = digits[3:]
	elif len(digits) == 10 and digits.startswith("0"):
		digits = digits[1:]

	# Now we expect 9-digit local part starting with 7 or 1
	if len(digits) != 9 or digits[0] not in ("7", "1"):
		raise ValueError("Invalid Kenyan mobile number")

	return f"+254{digits}"


def _post(url: str, payload: Dict[str, Any], timeout: int, mode: str = "form") -> Dict[str, Any] | str:
	"""
	POST payload to TextSMS and return:
	  - dict if JSON response, else
	  - raw text (str)

	Many SMS gateways expect form-urlencoded payload; default mode="form".
	"""
	if mode == "json":
		r = requests.post(url, json=payload, timeout=timeout)
	else:
		# ✅ Most likely required by TextSMS: form-data
		r = requests.post(url, data=payload, timeout=timeout)

	r.raise_for_status()

	# Try JSON first, fallback to text
	try:
		return r.json()
	except Exception:
		return (r.text or "").strip()


def _parse_textsms_response(data: Dict[str, Any] | str, msisdn: str) -> Dict[str, Any]:
	"""
	TextSMS common JSON shape:
	  { "responses": [ { "response-code": "...", "response-description": "...", ... } ] }

	But some gateways can return text. We handle both.
	"""
	# If we got raw text, return it as a failure unless it clearly says success-ish
	if isinstance(data, str):
		txt = (data or "").strip()
		ok = _looks_like_success(txt)
		return {
			"ok": ok,
			"status": txt[:200] if txt else "Unknown",
			"message_id": None,
			"mobile": msisdn,
			"cost": None,
			"code": None,
			"raw": txt,
			**({} if ok else {"error": txt or "Send failed"}),
		}

	resp = (data.get("responses") or [{}])[0] if isinstance(data, dict) else {}
	status_text = (resp.get("response-description") or resp.get("status") or "").strip()

	ok = _looks_like_success(status_text) or str(resp.get("response-code") or "").strip() in ("0", "00", "200")

	return {
		"ok": bool(ok),
		"status": status_text or "Unknown",
		"message_id": resp.get("messageid") or resp.get("message_id"),
		"mobile": resp.get("mobile") or msisdn,
		"cost": resp.get("cost"),
		"code": resp.get("response-code") or resp.get("code"),
		"raw": data,
		**({} if ok else {"error": status_text or "Send failed"}),
	}


def _looks_like_success(status_text: str) -> bool:
	s = (status_text or "").strip().lower()
	if not s:
		return False
	# Common success variants returned by gateways
	return any(
		k in s
		for k in (
			"success",
			"successful",
			"sent",
			"queued",
			"accepted",
			"ok",
		)
	)
