// Copyright (c) 2026, Karani Geoffrey and contributors
// For license information, please see license.txt

// Messages are viewed in the SMS console: open this one's campaign there.
// Replace the history entry so Back does not bounce between here and the console.
frappe.ui.form.on("SMS Send Log", {
	refresh(frm) {
		frappe.route_flags.replace_route = true;
		if (frm.doc.campaign) frappe.set_route("bulk-sms-console", "campaign", frm.doc.campaign);
		else frappe.set_route("bulk-sms-console", "messages");
	},
});
