// Copyright (c) 2026, Karani Geoffrey and contributors
// For license information, please see license.txt

// Campaigns are viewed in the SMS console. Replace the history entry so
// Back does not bounce the person between this form and the console.
frappe.ui.form.on("SMS Campaign", {
	refresh(frm) {
		frappe.route_flags.replace_route = true;
		if (frm.is_new()) frappe.set_route("bulk-sms-console", "bulk");
		else frappe.set_route("bulk-sms-console", "campaign", frm.doc.name);
	},
});
