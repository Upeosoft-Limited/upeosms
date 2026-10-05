// Copyright (c) 2026, Karani Geoffrey and contributors
// For license information, please see license.txt

// The message list lives in the SMS console's Messages tab.
frappe.listview_settings["SMS Send Log"] = {
	onload() {
		frappe.route_flags.replace_route = true;
		frappe.set_route("bulk-sms-console", "messages");
	},
};
