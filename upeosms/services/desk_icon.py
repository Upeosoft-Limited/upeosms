import frappe


class DeskIconBranding:
	"""Gives an app's tile on the /desk home screen its own image."""

	def __init__(self, label: str, logo_url: str):
		self.label = label
		self.logo_url = logo_url

	def apply(self) -> bool:
		name = frappe.db.get_value(
			"Desktop Icon", {"label": self.label, "icon_type": ["!=", "Folder"]}, "name"
		)
		if not name or frappe.db.get_value("Desktop Icon", name, "logo_url") == self.logo_url:
			return False
		frappe.db.set_value("Desktop Icon", name, "logo_url", self.logo_url)
		# Desktop icons are cached per user in the boot info.
		frappe.cache.delete_key("desktop_icons")
		frappe.cache.delete_key("bootinfo")
		return True


def after_migrate():
	DeskIconBranding("UPEO SMS", "/assets/upeosms/images/upeosms-icon.svg").apply()
