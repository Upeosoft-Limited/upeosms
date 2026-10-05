// The UPEO SMS workspace is replaced by the SMS console, so send people there.
// Replace the history entry so Back does not bounce them straight back here.
frappe.router.on("change", () => {
	const route = frappe.get_route();
	if (route[0] === "Workspaces" && route[route.length - 1] === "UPEO SMS") {
		frappe.route_flags.replace_route = true;
		frappe.set_route("bulk-sms-console");
	}
});
