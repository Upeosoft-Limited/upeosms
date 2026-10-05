// Copyright (c) 2026, Karani Geoffrey and contributors
// For license information, please see license.txt

frappe.ui.form.on("UPEOSMS Settings", {
	refresh(frm) {
		frm.events.render_sender(frm);
	},

	render_sender(frm) {
		const sender = frm.doc.__onload?.sender || {};
		const notes = {
			own: __("This site's own TextSMS account."),
			shared: __("Shared account from the bench-wide config. Other sites may send as this sender too."),
			missing: __("No TextSMS account is set up for this site, so SMS cannot be sent."),
		};
		const colours = { own: "green", shared: "orange", missing: "red" };
		frm.get_field("sender_html").$wrapper.html(`
			<div class="form-group">
				<div class="control-label">${__("Sender ID")}</div>
				<div class="indicator-pill ${colours[sender.source] || "gray"}" style="margin:4px 0 6px">
					${frappe.utils.escape_html(sender.sender_id || __("Not set"))}
				</div>
				<p class="help-box small text-muted">
					${notes[sender.source] || ""}
					${__("Every SMS from this site goes out under this name. It is set by the server administrator.")}
				</p>
			</div>
		`);
	},
});
