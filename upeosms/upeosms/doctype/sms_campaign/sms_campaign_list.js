// Copyright (c) 2026, Karani Geoffrey and contributors
// For license information, please see license.txt

// The campaign list lives in the SMS console's History tab.
frappe.listview_settings["SMS Campaign"] = {
	onload() {
		frappe.route_flags.replace_route = true;
		frappe.set_route("bulk-sms-console", "history");
	},
};
