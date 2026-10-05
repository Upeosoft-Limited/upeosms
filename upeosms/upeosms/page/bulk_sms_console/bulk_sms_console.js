frappe.provide("upeosms.bulk_sms");

frappe.pages["bulk-sms-console"].on_page_load = function (wrapper) {
	wrapper.usms_console = new UpeoSmsConsole(wrapper);
};

// Desk screens for campaigns and settings send people here with route options.
frappe.pages["bulk-sms-console"].on_page_show = function (wrapper) {
	wrapper.usms_console?.apply_route();
};

const USMS_ICONS = {
	logo: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>`,
	upload: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/></svg>`,
	file: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/></svg>`,
	download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`,
	send: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>`,
};

const USMS_STATUS_COLOURS = {
	Draft: "",
	Ready: "blue",
	Queued: "blue live",
	Sending: "blue live",
	Completed: "green",
	"Completed with Errors": "orange",
	Failed: "red",
	Sent: "green",
	Pending: "blue",
	Processing: "blue live",
};

const esc = (value) => frappe.utils.escape_html(value == null ? "" : String(value));

/** Server calls. Errors come back as plain text so panels can show them inline. */
class UsmsApi {
	static call(method, args = {}) {
		return new Promise((resolve, reject) => {
			frappe.call({
				method: `upeosms.api.page.${method}`,
				args,
				silent: true,
				callback: (r) => resolve(r.message),
				error: (r) => reject(UsmsApi.error_text(r)),
			});
		});
	}

	static error_text(r) {
		try {
			const messages = JSON.parse(r?._server_messages || "[]").map((m) => {
				const parsed = JSON.parse(m);
				return parsed.message || parsed;
			});
			if (messages.length) return $("<div>").html(messages.join(" ")).text();
		} catch (e) {
			console.error(e);
		}
		return __("Something went wrong. Please try again.");
	}

	static upload(file) {
		return new Promise((resolve, reject) => {
			const form = new FormData();
			form.append("file", file, file.name);
			form.append("is_private", 1);
			$.ajax({
				url: "/api/method/upload_file",
				type: "POST",
				data: form,
				processData: false,
				contentType: false,
				headers: { "X-Frappe-CSRF-Token": frappe.csrf_token },
				success: (r) => (r?.message ? resolve(r.message) : reject(__("Upload failed."))),
				error: (xhr) => reject(UsmsApi.error_text(xhr.responseJSON) || __("Upload failed.")),
			});
		});
	}
}

/** Mirrors upeosms.services.message_composer so previews match what is sent. */
class UsmsText {
	static GSM =
		/^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
	static GSM_EXTENDED = /[\^{}\\[~\]|€]/g;

	static variables(template) {
		return [...new Set([...(template || "").matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))];
	}

	static render(template, row) {
		let message = template || "";
		Object.entries(row || {}).forEach(([key, value]) => {
			message = message.split(`{${key}}`).join(value == null ? "" : String(value));
		});
		return message;
	}

	static sign(message, signature) {
		message = (message || "").trimEnd();
		if (!signature || !message || message.endsWith(signature)) return message;
		return `${message}\n\n${signature}`;
	}

	static segments(text) {
		if (!text) return { length: 0, parts: 0 };
		if (UsmsText.GSM.test(text)) {
			const length = text.length + (text.match(UsmsText.GSM_EXTENDED) || []).length;
			return { length, parts: length <= 160 ? 1 : Math.ceil(length / 153) };
		}
		const length = [...text].length;
		return { length, parts: length <= 70 ? 1 : Math.ceil(length / 67) };
	}
}

/** The phone mock-up that shows exactly what a recipient will read. */
class UsmsPhonePreview {
	constructor($root, sender) {
		this.$root = $root;
		const name = sender.sender_id || __("Sender");
		$root.html(`
			<div class="usms-phone">
				<div class="usms-phone-screen">
					<div class="usms-phone-top">
						<div class="usms-avatar">${esc(name.charAt(0))}</div>
						<div class="usms-phone-name">${esc(name)}</div>
					</div>
					<div class="usms-phone-body">
						<div class="usms-bubble placeholder"></div>
						<div class="usms-phone-meta"></div>
					</div>
				</div>
			</div>
		`);
		this.$bubble = $root.find(".usms-bubble");
		this.$meta = $root.find(".usms-phone-meta");
		this.show("", "");
	}

	show(body, signature, note = "") {
		if (!body) {
			this.$bubble.addClass("placeholder").text(__("Your message will appear here as people will see it."));
			this.$meta.text(note);
			return;
		}
		const text = body.trimEnd();
		const signed = UsmsText.sign(text, signature);
		const sig = signed === text ? "" : `\n\n<span class="usms-bubble-sig">${esc(signature)}</span>`;
		this.$bubble.removeClass("placeholder").html(esc(text) + sig);
		const seg = UsmsText.segments(signed);
		this.$meta.text(
			[note, __("{0} characters", [seg.length]), seg.parts === 1 ? __("1 SMS") : __("{0} SMS each", [seg.parts])]
				.filter(Boolean)
				.join(" · ")
		);
	}
}

/** Live progress of the campaign being sent: realtime events plus a polling fallback. */
class UsmsCampaignStatus {
	constructor($root) {
		this.$root = $root;
		this.campaign = null;
		$root.html(`
			<div class="usms-card">
				<div class="usms-card-head">
					<div><h2>${__("Delivery")}</h2><p class="usms-status-sub">${__("Nothing sending yet")}</p></div>
					<div class="usms-spacer"></div>
					<span class="usms-status-pill">${__("Draft")}</span>
				</div>
				<div class="usms-progress"><div class="usms-progress-fill"></div></div>
				<div class="usms-stats">
					<div class="usms-stat sent"><span>${__("Sent")}</span><strong data-k="sent">0</strong></div>
					<div class="usms-stat failed"><span>${__("Failed")}</span><strong data-k="failed">0</strong></div>
					<div class="usms-stat"><span>${__("Waiting")}</span><strong data-k="queued">0</strong></div>
				</div>
			</div>
		`);
		this.on_event = (data) => data?.campaign === this.campaign && this.render(data);
		frappe.realtime.on("upeosms_campaign_progress", this.on_event);
	}

	watch(campaign, data = {}) {
		this.campaign = campaign;
		this.render(data);
		this.poll();
	}

	reset() {
		this.campaign = null;
		clearTimeout(this.timer);
		this.render({ status: "Draft" });
		this.$root.find(".usms-status-sub").text(__("Nothing sending yet"));
	}

	async poll() {
		clearTimeout(this.timer);
		if (!this.campaign) return;
		try {
			const data = await UsmsApi.call("get_campaign_progress_from_page", { campaign_name: this.campaign });
			this.render(data);
			if (["Queued", "Sending"].includes(data.status)) {
				this.timer = setTimeout(() => this.poll(), 3000);
			} else {
				this.on_finished && this.on_finished(data);
			}
		} catch (e) {
			this.timer = setTimeout(() => this.poll(), 6000);
		}
	}

	render(data) {
		const status = data.status || "Draft";
		const total = cint(data.total);
		const sent = cint(data.sent);
		const failed = cint(data.failed);
		this.$root
			.find(".usms-status-pill")
			.attr("class", `usms-status-pill ${USMS_STATUS_COLOURS[status] || ""}`)
			.text(__(status));
		if (this.campaign) {
			this.$root
				.find(".usms-status-sub")
				.text(total ? __("{0} of {1} done", [sent + failed, total]) : __("Campaign {0}", [this.campaign]));
		}
		this.$root.find(".usms-progress-fill").css("width", `${flt(data.progress_percent)}%`);
		this.$root.find("[data-k=sent]").text(sent);
		this.$root.find("[data-k=failed]").text(failed);
		this.$root.find("[data-k=queued]").text(cint(data.queued));
	}
}

/** The last few campaigns; each opens its details inside the console. */
class UsmsRecentCampaigns {
	constructor($root, on_open) {
		this.$root = $root;
		$root.on("click", "[data-campaign]", (e) => on_open($(e.currentTarget).data("campaign")));
	}

	render(campaigns) {
		const rows = (campaigns || [])
			.map(
				(c) => `
				<button type="button" class="usms-list-item" data-campaign="${esc(c.name)}">
					<div class="usms-list-main">
						<div class="usms-list-title">${esc(c.campaign_name || c.name)}</div>
						<div class="usms-list-sub">${__("{0} of {1} sent", [cint(c.sent_count), cint(c.total_recipients)])} · ${esc(
							frappe.datetime.prettyDate(c.creation)
						)}</div>
					</div>
					<span class="usms-status-pill ${(USMS_STATUS_COLOURS[c.status] || "").replace("live", "")}">${esc(__(c.status))}</span>
				</button>`
			)
			.join("");
		this.$root.html(`
			<div class="usms-card">
				<div class="usms-card-head">
					<div><h2>${__("Recent campaigns")}</h2></div>
					<div class="usms-spacer"></div>
					<button type="button" class="usms-link-btn usms-see-all">${__("See all")}</button>
				</div>
				<div class="usms-list">${rows || `<div class="usms-empty">${__("No campaigns yet.")}</div>`}</div>
			</div>
		`);
	}
}

/** Upload a file, write a template, review, send. */
class UsmsBulkPanel {
	constructor($root, console) {
		this.$root = $root;
		this.console = console;
		this.campaign = null;
		this.columns = [];
		this.rows = [];
		this.total = 0;
		this.render();
		this.bind();
	}

	render() {
		this.$root.html(`
			<div class="usms-card">
				<div class="usms-card-head">
					<div class="usms-step" data-step="1">1</div>
					<div><h2>${__("Who's receiving?")}</h2><p>${__("Upload an Excel or CSV list of people.")}</p></div>
				</div>
				<div class="usms-field">
					<label class="usms-label">${__("Campaign name")}</label>
					<input class="usms-input usms-campaign-name" type="text" placeholder="${__("e.g. October pledge reminder")}">
				</div>
				<div class="usms-field">
					<label class="usms-drop">
						<input type="file" accept=".csv,.xlsx">
						<div class="usms-drop-icon">${USMS_ICONS.upload}</div>
						<div>
							<div class="usms-drop-title">${__("Drop your file here, or click to browse")}</div>
							<div class="usms-drop-sub">${__("Excel (.xlsx) or CSV")}</div>
						</div>
					</label>
					<div class="usms-hint">
						<span>${__("Needs a {0} column. Every other column becomes a variable, like {1}.", [
							"<code>mobile</code>",
							"<code>{name}</code>",
						])}</span>
						<a class="usms-link-btn usms-sample" href="#">${USMS_ICONS.download} ${__("Download sample file")}</a>
					</div>
				</div>
				<div class="usms-notice usms-upload-notice"></div>
			</div>

			<div class="usms-card">
				<div class="usms-card-head">
					<div class="usms-step" data-step="2">2</div>
					<div><h2>${__("Write your message")}</h2><p>${__("Click a variable to drop it in.")}</p></div>
				</div>
				<div class="usms-chips"></div>
				<textarea class="usms-textarea usms-template" placeholder="${__(
					"Hi {name}, thank you for your pledge of KES {amount}."
				)}"></textarea>
				<div class="usms-meta"><span class="usms-sig-note"></span><span class="usms-count"></span></div>
			</div>

			<div class="usms-card">
				<div class="usms-card-head">
					<div class="usms-step" data-step="3">3</div>
					<div><h2>${__("Review and send")}</h2><p class="usms-review-sub">${__("The first few messages, exactly as they will go out.")}</p></div>
				</div>
				<div class="usms-preview"><div class="usms-empty">${__("Upload a file to see a preview.")}</div></div>
				<div class="usms-notice usms-send-notice"></div>
				<div class="usms-actions">
					<button class="usms-btn usms-cancel" style="display:none">${__("Cancel")}</button>
					<button class="usms-btn primary usms-send" disabled>${USMS_ICONS.send} <span>${__("Send")}</span></button>
				</div>
			</div>
		`);
		this.$name = this.$root.find(".usms-campaign-name");
		this.$drop = this.$root.find(".usms-drop");
		this.$file = this.$drop.find("input");
		this.$template = this.$root.find(".usms-template");
		this.$send = this.$root.find(".usms-send");
		this.$cancel = this.$root.find(".usms-cancel");
	}

	bind() {
		this.$file.on("change", () => {
			if (this.$file[0].files[0]) this.upload(this.$file[0].files[0]);
		});
		this.$drop
			.on("dragover", (e) => {
				e.preventDefault();
				this.$drop.addClass("over");
			})
			.on("dragleave drop", () => this.$drop.removeClass("over"))
			.on("drop", (e) => {
				e.preventDefault();
				const file = e.originalEvent.dataTransfer?.files?.[0];
				file && this.upload(file);
			});
		this.$root.find(".usms-sample").on("click", (e) => {
			e.preventDefault();
			window.open("/api/method/upeosms.api.page.download_sample_file");
		});
		this.$template.on("input", () => this.refresh());
		this.$send.on("click", () => this.on_send());
		this.$cancel.on("click", () => this.disarm());
	}

	on_show() {
		this.refresh();
	}

	notice(selector, text, kind = "error") {
		const $n = this.$root.find(selector);
		$n.attr("class", `usms-notice ${selector.slice(1)} ${text ? `show ${kind}` : ""}`).text(text || "");
	}

	async upload(file) {
		this.notice(".usms-upload-notice", "");
		if (!this.$name.val().trim()) {
			this.$name.val(`${file.name.replace(/\.[^.]+$/, "")} · ${frappe.datetime.str_to_user(frappe.datetime.get_today())}`);
		}
		this.$drop.removeClass("loaded").find(".usms-drop-title").text(__("Reading {0}…", [file.name]));
		try {
			const doc = await UsmsApi.upload(file);
			const data = await UsmsApi.call("create_or_update_campaign_from_page", {
				campaign_name: this.$name.val().trim(),
				file_url: doc.file_url,
				message_template: this.$template.val(),
			});
			this.campaign = data.campaign;
			this.columns = data.columns || [];
			this.rows = (data.preview || []).map((p) => p.data);
			this.total = cint(data.total);
			this.$drop.addClass("loaded").find(".usms-drop-icon").html(USMS_ICONS.file);
			this.$drop.find(".usms-drop-title").text(file.name);
			this.$drop.find(".usms-drop-sub").text(__("{0} people loaded · click to replace", [this.total]));
			this.$root.find("[data-step=1]").addClass("done").text("✓");
			this.console.status.watch(this.campaign, { status: data.status, total: this.total, queued: 0 });
			this.render_chips();
			this.refresh();
		} catch (error) {
			this.$drop.find(".usms-drop-title").text(__("Drop your file here, or click to browse"));
			this.notice(".usms-upload-notice", error);
		} finally {
			this.$file.val("");
		}
	}

	render_chips() {
		const $chips = this.$root.find(".usms-chips").empty();
		this.columns.forEach((col) => {
			$(`<button type="button" class="usms-chip">{${esc(col)}}</button>`)
				.on("click", () => this.insert(`{${col}}`))
				.appendTo($chips);
		});
	}

	insert(text) {
		const el = this.$template[0];
		const start = el.selectionStart ?? el.value.length;
		el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd ?? start);
		el.focus();
		el.selectionStart = el.selectionEnd = start + text.length;
		this.refresh();
	}

	missing_variables() {
		return UsmsText.variables(this.$template.val()).filter((v) => !this.columns.includes(v));
	}

	refresh() {
		const template = this.$template.val();
		const signature = this.console.signature;
		const first = UsmsText.render(template, this.rows[0] || {});
		const seg = UsmsText.segments(UsmsText.sign(first, signature));
		this.$root.find(".usms-count").html(
			template ? `<b>${seg.length}</b> ${__("characters")} · <b>${seg.parts}</b> ${seg.parts === 1 ? __("SMS") : __("SMS each")}` : ""
		);
		this.$root.find(".usms-sig-note").html(this.console.signature_note());
		this.$root.find("[data-step=2]").toggleClass("done", !!template.trim()).text(template.trim() ? "✓" : "2");
		this.console.phone.show(template ? first : "", signature, this.rows[0]?.name ? __("To {0}", [this.rows[0].name]) : "");
		this.render_preview(template);
		this.disarm();
	}

	render_preview(template) {
		const missing = this.missing_variables();
		this.notice(
			".usms-send-notice",
			this.campaign && missing.length
				? __("Your file has no column for {0}. Fix the message or the file.", [missing.map((m) => `{${m}}`).join(", ")])
				: "",
			"warn"
		);
		this.$send.prop("disabled", !this.campaign || !template.trim() || missing.length > 0);
		this.$send.find("span").text(this.total ? __("Send to {0} people", [this.total]) : __("Send"));
		if (!this.rows.length) return;
		const body = this.rows
			.map(
				(row) => `<tr>
					<td class="num">${esc(row.mobile)}</td>
					<td class="num">${esc(row.name || row.full_name || "")}</td>
					<td>${esc(template ? UsmsText.sign(UsmsText.render(template, row), this.console.signature) : "—")}</td>
				</tr>`
			)
			.join("");
		this.$root.find(".usms-preview").html(`
			<div class="usms-table-wrap"><table class="usms-table">
				<thead><tr><th>${__("Mobile")}</th><th>${__("Name")}</th><th>${__("Message")}</th></tr></thead>
				<tbody>${body}</tbody>
			</table></div>
		`);
		this.$root
			.find(".usms-review-sub")
			.text(
				this.total > this.rows.length
					? __("The first {0} of {1} messages, exactly as they will go out.", [this.rows.length, this.total])
					: __("Every message, exactly as it will go out.")
			);
	}

	// Sending is two clicks: the first arms the button, the second sends.
	on_send() {
		if (!this.$send.hasClass("danger")) {
			this.$send.addClass("danger").removeClass("primary");
			this.$send
				.find("span")
				.text(__("Confirm: send {0} SMS as {1}", [this.total, this.console.sender.sender_id || __("this sender")]));
			this.$cancel.show();
			return;
		}
		this.send();
	}

	disarm() {
		this.$send.removeClass("danger").addClass("primary");
		this.$send.find("span").text(this.total ? __("Send to {0} people", [this.total]) : __("Send"));
		this.$cancel.hide();
	}

	async send() {
		this.$send.addClass("loading");
		this.$cancel.hide();
		try {
			const r = await UsmsApi.call("start_campaign_from_page", {
				campaign_name: this.campaign,
				message_template: this.$template.val(),
			});
			this.$root.find("[data-step=3]").addClass("done").text("✓");
			this.notice(".usms-send-notice", r?.message || __("Campaign queued."), "ok");
			frappe.show_alert({ message: __("Sending started"), indicator: "green" });
			this.console.status.watch(this.campaign, { status: "Queued", total: this.total, queued: this.total });
			this.console.load_recent();
			this.$send.prop("disabled", true).find("span").text(__("Sending started"));
		} catch (error) {
			this.notice(".usms-send-notice", error);
			this.disarm();
		} finally {
			this.$send.removeClass("loading");
		}
	}
}

/** Send a message to a few typed-in numbers, no file needed. */
class UsmsQuickPanel {
	static KE_MOBILE = /^(?:\+?254|0)?[17]\d{8}$/;

	constructor($root, console) {
		this.$root = $root;
		this.console = console;
		this.numbers = [];
		this.render();
		this.bind();
	}

	render() {
		const limit = this.console.quick_send_limit;
		this.$root.html(`
			<div class="usms-card">
				<div class="usms-card-head">
					<div class="usms-step">1</div>
					<div><h2>${__("Send a test")}</h2><p>${__(
						"Check how a message lands on one or a few phones, up to {0}, before a full campaign.",
						[limit]
					)}</p></div>
				</div>
				<div class="usms-field">
					<label class="usms-label">${__("Phone numbers")}</label>
					<div class="usms-tokens"><input type="text" inputmode="tel" placeholder="${__(
						"07XX XXX XXX, then Enter"
					)}"></div>
					<div class="usms-meta"><span>${__("Separate numbers with Enter, a comma or a space. You can paste several.")}</span><span class="usms-num-count"></span></div>
				</div>
				<div class="usms-field">
					<label class="usms-label">${__("Message")}</label>
					<textarea class="usms-textarea usms-quick-message" placeholder="${__("Type the message to send.")}"></textarea>
					<div class="usms-meta"><span class="usms-sig-note"></span><span class="usms-count"></span></div>
				</div>
				<div class="usms-notice usms-quick-notice"></div>
				<div class="usms-actions">
					<button class="usms-btn primary usms-quick-send" disabled>${USMS_ICONS.send} <span>${__("Send test")}</span></button>
				</div>
			</div>
			<div class="usms-card usms-results" style="display:none">
				<div class="usms-card-head"><div><h2>${__("Results")}</h2><p class="usms-results-sub"></p></div></div>
				<div class="usms-list"></div>
			</div>
		`);
		this.$tokens = this.$root.find(".usms-tokens");
		this.$input = this.$tokens.find("input");
		this.$message = this.$root.find(".usms-quick-message");
		this.$send = this.$root.find(".usms-quick-send");
	}

	bind() {
		this.$tokens.on("click", () => this.$input.focus());
		this.$input.on("keydown", (e) => {
			if (["Enter", ",", " ", "Tab"].includes(e.key) && this.$input.val().trim()) {
				e.preventDefault();
				this.add(this.$input.val());
			} else if (e.key === "Backspace" && !this.$input.val() && this.numbers.length) {
				this.remove(this.numbers.length - 1);
			}
		});
		this.$input.on("paste", (e) => {
			e.preventDefault();
			this.add(e.originalEvent.clipboardData.getData("text"));
		});
		this.$input.on("blur", () => {
			if (this.$input.val().trim()) this.add(this.$input.val());
		});
		this.$message.on("input", () => this.refresh());
		this.$send.on("click", () => this.send());
	}

	on_show() {
		this.refresh();
	}

	add(text) {
		text.split(/[\s,;]+/)
			.map((n) => n.trim())
			.filter((n) => n && !this.numbers.includes(n))
			.forEach((n) => this.numbers.push(n));
		this.$input.val("");
		this.render_tokens();
	}

	remove(index) {
		this.numbers.splice(index, 1);
		this.render_tokens();
	}

	render_tokens() {
		this.$tokens.find(".usms-token").remove();
		this.numbers.forEach((n, i) => {
			const valid = UsmsQuickPanel.KE_MOBILE.test(n.replace(/[\s-]/g, ""));
			$(`<span class="usms-token ${valid ? "" : "invalid"}" title="${valid ? "" : __("Not a valid Kenyan mobile number")}">
				${esc(n)}<button type="button" aria-label="${__("Remove")}">×</button></span>`)
				.on("click", "button", (e) => {
					e.stopPropagation();
					this.remove(i);
				})
				.insertBefore(this.$input);
		});
		this.refresh();
	}

	refresh() {
		const message = this.$message.val();
		const limit = this.console.quick_send_limit;
		const invalid = this.numbers.filter((n) => !UsmsQuickPanel.KE_MOBILE.test(n.replace(/[\s-]/g, "")));
		const variables = UsmsText.variables(message);
		const seg = UsmsText.segments(UsmsText.sign(message, this.console.signature));
		this.$root.find(".usms-num-count").text(this.numbers.length ? `${this.numbers.length} / ${limit}` : "");
		this.$root.find(".usms-sig-note").html(this.console.signature_note());
		this.$root
			.find(".usms-count")
			.html(message ? `<b>${seg.length}</b> ${__("characters")} · <b>${seg.parts}</b> ${seg.parts === 1 ? __("SMS") : __("SMS each")}` : "");
		let problem = "";
		if (this.numbers.length > limit) problem = __("A test can go to at most {0} numbers.", [limit]);
		else if (invalid.length) problem = __("Check these numbers: {0}", [invalid.join(", ")]);
		else if (variables.length)
			problem = __("{0} can't be filled in a test, since there is no file. Type the real words instead.", [
				variables.map((v) => `{${v}}`).join(", "),
			]);
		this.notice(problem, "warn");
		this.$send.prop("disabled", !!problem || !this.numbers.length || !message.trim());
		this.$send
			.find("span")
			.text(this.numbers.length > 1 ? __("Send test to {0} numbers", [this.numbers.length]) : __("Send test"));
		this.console.phone.show(message, this.console.signature);
	}

	notice(text, kind = "error") {
		this.$root
			.find(".usms-quick-notice")
			.attr("class", `usms-notice usms-quick-notice ${text ? `show ${kind}` : ""}`)
			.text(text || "");
	}

	async send() {
		this.$send.addClass("loading");
		this.notice("");
		try {
			const r = await UsmsApi.call("quick_send", { numbers: this.numbers.join("\n"), message: this.$message.val() });
			this.show_results(r.results || []);
			this.console.load_recent();
		} catch (error) {
			this.notice(error);
		} finally {
			this.$send.removeClass("loading");
		}
	}

	show_results(results) {
		const sent = results.filter((r) => r.status === "Sent").length;
		const $card = this.$root.find(".usms-results").show();
		$card.find(".usms-results-sub").text(__("{0} of {1} delivered to TextSMS", [sent, results.length]));
		$card.find(".usms-list").html(
			results
				.map(
					(r) => `<div class="usms-list-item">
						<div class="usms-list-main">
							<div class="usms-list-title">${esc(r.mobile)}</div>
							${r.status === "Sent" ? "" : `<div class="usms-list-sub">${esc((r.error_message || "").split("\n").pop())}</div>`}
						</div>
						<span class="usms-status-pill ${USMS_STATUS_COLOURS[r.status] || ""}">${esc(__(r.status))}</span>
					</div>`
				)
				.join("")
		);
		frappe.show_alert({
			message: sent === results.length ? __("Test sent") : __("Some numbers failed"),
			indicator: sent === results.length ? "green" : "orange",
		});
	}
}

/** A small chip input: type a value, press Enter or comma, remove with ×. */
class UsmsTokenField {
	constructor($root, { placeholder, validate, sort, inputmode = "text", disabled = false, on_change }) {
		this.$root = $root;
		this.values = [];
		this.validate = validate || (() => true);
		this.sort = sort;
		this.on_change = on_change || (() => {});
		$root.addClass("usms-tokens").html(
			`<input type="text" inputmode="${inputmode}" placeholder="${esc(placeholder)}" ${disabled ? "disabled" : ""}>`
		);
		this.$input = $root.find("input");
		$root.on("click", () => this.$input.trigger("focus"));
		this.$input.on("keydown", (e) => {
			if (["Enter", ",", " ", "Tab"].includes(e.key) && this.$input.val().trim()) {
				e.preventDefault();
				this.add(this.$input.val());
			} else if (e.key === "Backspace" && !this.$input.val() && this.values.length) {
				this.remove(this.values.length - 1);
			}
		});
		this.$input.on("blur", () => {
			if (this.$input.val().trim()) this.add(this.$input.val());
		});
		this.$input.on("paste", (e) => {
			e.preventDefault();
			this.add(e.originalEvent.clipboardData.getData("text"));
		});
		$root.on("click", ".usms-token button", (e) => {
			e.stopPropagation();
			this.remove(cint($(e.currentTarget).closest(".usms-token").data("i")));
		});
	}

	set(values) {
		this.values = [...values].map(String);
		this.render();
	}

	add(text) {
		String(text)
			.split(/[\s,;]+/)
			.map((v) => v.trim())
			.filter((v) => v && !this.values.includes(v))
			.forEach((v) => this.values.push(v));
		if (this.sort) this.values.sort(this.sort);
		this.$input.val("");
		this.render();
		this.on_change();
	}

	remove(index) {
		this.values.splice(index, 1);
		this.render();
		this.on_change();
	}

	invalid() {
		return this.values.filter((v) => !this.validate(v));
	}

	render(extra_class = () => "") {
		this.$root.find(".usms-token").remove();
		this.values.forEach((v, i) => {
			$(`<span class="usms-token ${this.validate(v) ? "" : "invalid"} ${extra_class(v)}" data-i="${i}">${esc(
				v
			)}<button type="button" aria-label="${__("Remove")}">×</button></span>`).insertBefore(this.$input);
		});
	}
}

/** The SMS balance and who is told when it runs low. */
class UsmsBalanceCard {
	constructor($root, console) {
		this.$root = $root;
		this.console = console;
		this.state = console.balance_alerts || {};
		this.render();
		this.bind();
		this.load(this.state);
	}

	render() {
		const locked = !this.console.can_edit_settings;
		this.$root.html(`
			<div class="usms-card">
				<div class="usms-card-head">
					<div><h2>${__("SMS balance & alerts")}</h2><p>${__(
						"Get a text when the balance falls to the levels you choose. Checked every 10 minutes."
					)}</p></div>
				</div>
				<div class="usms-balance">
					<div>
						<div class="usms-eyebrow">${__("Balance")}</div>
						<div class="usms-balance-value"><span class="usms-balance-number">—</span> <small>${__("units")}</small></div>
						<div class="usms-list-sub usms-balance-checked"></div>
					</div>
					<div class="usms-spacer"></div>
					<button type="button" class="usms-btn usms-balance-check">${__("Check now")}</button>
				</div>

				<label class="usms-switch">
					<input type="checkbox" class="usms-alerts-enabled" ${locked ? "disabled" : ""}>
					<span class="usms-switch-track"><span class="usms-switch-thumb"></span></span>
					<span>${__("Send low balance alerts")}</span>
				</label>

				<div class="usms-alert-fields">
					<div class="usms-field">
						<label class="usms-label">${__("Alert when the balance falls to")}</label>
						<div class="usms-levels"></div>
						<div class="usms-meta"><span>${__("SMS units. Type a number and press Enter.")}</span><span class="usms-levels-note"></span></div>
					</div>
					<div class="usms-field">
						<label class="usms-label">${__("Send alerts to")}</label>
						<div class="usms-alert-numbers"></div>
						<div class="usms-meta"><span>${__("Up to 10 phone numbers.")}</span></div>
					</div>
				</div>
				<div class="usms-notice usms-balance-notice"></div>
				<div class="usms-actions">
					<button class="usms-btn primary usms-alerts-save" disabled ${locked ? "hidden" : ""}><span>${__(
						"Save alerts"
					)}</span></button>
				</div>
			</div>
		`);
		const on_change = () => this.refresh();
		this.levels = new UsmsTokenField(this.$root.find(".usms-levels"), {
			placeholder: __("e.g. 500"),
			inputmode: "numeric",
			validate: (v) => /^\d+$/.test(v) && cint(v) > 0,
			sort: (a, b) => cint(b) - cint(a),
			disabled: locked,
			on_change,
		});
		this.numbers = new UsmsTokenField(this.$root.find(".usms-alert-numbers"), {
			placeholder: __("07XX XXX XXX"),
			inputmode: "tel",
			validate: (v) => UsmsQuickPanel.KE_MOBILE.test(v.replace(/[\s-]/g, "")),
			disabled: locked,
			on_change,
		});
		this.$enabled = this.$root.find(".usms-alerts-enabled");
		this.$save = this.$root.find(".usms-alerts-save");
	}

	bind() {
		this.$enabled.on("change", () => this.refresh());
		this.$save.on("click", () => this.save());
		this.$root.find(".usms-balance-check").on("click", (e) => this.check($(e.currentTarget)));
	}

	load(state) {
		this.state = { ...this.state, ...state };
		this.$enabled.prop("checked", !!this.state.enabled);
		this.levels.set(this.state.thresholds || []);
		this.numbers.set(this.state.recipients || []);
		this.show_balance();
		this.refresh();
	}

	show_balance() {
		const { balance, checked_on } = this.state;
		const has = balance !== null && balance !== undefined && checked_on;
		this.$root.find(".usms-balance-number").text(has ? format_number(balance, null, 0) : "—");
		this.$root
			.find(".usms-balance-checked")
			.text(has ? __("Checked {0}", [frappe.datetime.prettyDate(checked_on)]) : __("Not checked yet"));
		this.console.show_balance(this.state);
	}

	current() {
		return {
			enabled: this.$enabled.is(":checked") ? 1 : 0,
			thresholds: this.levels.values.join(", "),
			recipients: this.numbers.values.join("\n"),
		};
	}

	refresh() {
		const now = this.current();
		const saved = {
			enabled: this.state.enabled ? 1 : 0,
			thresholds: (this.state.thresholds || []).join(", "),
			recipients: (this.state.recipients || []).join("\n"),
		};
		this.$root.find(".usms-alert-fields").toggleClass("off", !now.enabled);
		const balance = this.state.balance;
		const reached = (v) => (balance !== null && balance !== undefined && cint(v) >= balance ? "reached" : "");
		this.levels.render(reached);
		this.numbers.render();
		const reached_levels = this.levels.values.filter((v) => reached(v));
		this.$root
			.find(".usms-levels-note")
			.text(reached_levels.length ? __("Already at or below: {0}", [reached_levels.join(", ")]) : "");
		const problem = this.levels.invalid().length
			? __("Balance levels must be whole numbers above zero.")
			: this.numbers.invalid().length
				? __("Check these numbers: {0}", [this.numbers.invalid().join(", ")])
				: now.enabled && !this.levels.values.length
					? __("Add at least one balance level.")
					: now.enabled && !this.numbers.values.length
						? __("Add at least one phone number.")
						: "";
		this.notice(problem, "warn");
		const changed = JSON.stringify(now) !== JSON.stringify(saved);
		this.$save.prop("disabled", !changed || !!problem);
	}

	notice(text, kind = "ok") {
		this.$root
			.find(".usms-balance-notice")
			.attr("class", `usms-notice usms-balance-notice ${text ? `show ${kind}` : ""}`)
			.text(text || "");
	}

	async save() {
		this.$save.addClass("loading");
		try {
			const r = await UsmsApi.call("save_balance_alerts", this.current());
			this.load(r);
			this.notice(r.enabled ? __("Saved. Alerts are on.") : __("Saved. Alerts are off."));
		} catch (error) {
			this.notice(error, "error");
		} finally {
			this.$save.removeClass("loading");
		}
	}

	async check($btn) {
		$btn.addClass("loading");
		try {
			const r = await UsmsApi.call("check_balance_now");
			this.load(r);
			if (r.alert_sent) this.notice(__("The balance has reached an alert level, so an alert was sent."), "warn");
		} catch (error) {
			this.notice(error, "error");
		} finally {
			$btn.removeClass("loading");
		}
	}
}

/** Sender ID and signature, edited here instead of the desk settings form. */
class UsmsSettingsPanel {
	constructor($root, console) {
		this.$root = $root;
		this.console = console;
		this.render();
		this.bind();
	}

	render() {
		const sender = this.console.sender;
		const about = {
			own: [__("Own account"), __("This site sends from its own TextSMS account. No other site can send as this name.")],
			shared: [
				__("Shared account"),
				__("This site uses the server-wide TextSMS account, so other sites may send as this name too."),
			],
			missing: [__("Not set up"), __("No TextSMS account is set up for this site yet, so nothing can be sent.")],
		}[sender.source] || ["", ""];
		const colour = { own: "green", shared: "orange", missing: "red" }[sender.source] || "";
		const limit = this.console.signature_limit;
		const locked = !this.console.can_edit_settings;
		this.$root.html(`
			<div class="usms-card usms-sender-card">
				<div class="usms-sender-id">
					<div class="usms-avatar usms-avatar-lg">${esc((sender.sender_id || "?").charAt(0))}</div>
					<div>
						<div class="usms-eyebrow">${__("Sender ID")}</div>
						<div class="usms-sender-name">${esc(sender.sender_id || __("Not set"))}</div>
					</div>
					<div class="usms-spacer"></div>
					<span class="usms-status-pill ${colour}">${esc(about[0])}</span>
				</div>
				<p class="usms-sender-about">${esc(about[1])} ${__(
					"This is the name people see as the sender. Your server administrator sets it."
				)}</p>
			</div>

			<div class="usms-card">
				<div class="usms-card-head">
					<div><h2>${__("Signature")}</h2><p>${__(
						"Added at the end of every SMS sent from this console. Up to {0} lines.",
						[this.console.signature_max_lines]
					)}</p></div>
				</div>
				<div class="usms-editor ${locked ? "locked" : ""}">
					<div class="usms-editor-bar" role="toolbar" aria-label="${__("Insert")}">
						${this.snippets()
							.map(
								(text) =>
									`<button type="button" class="usms-editor-btn" data-insert="${esc(text)}" ${
										locked ? "disabled" : ""
									}>${esc(text)}</button>`
							)
							.join("")}
						<span class="usms-spacer"></span>
						<button type="button" class="usms-editor-btn usms-editor-clear" ${locked ? "disabled" : ""}>${__("Clear")}</button>
					</div>
					<textarea class="usms-editor-area usms-signature" rows="3" maxlength="${limit}" spellcheck="true"
						placeholder="${__("e.g.\nGod bless you,\nKSF Kitengela")}" ${locked ? "disabled" : ""}></textarea>
					<div class="usms-editor-foot">
						<span class="usms-sig-hint">${
							locked
								? __("Only a System Manager can change this.")
								: __("Enter starts a new line · Ctrl+Enter saves")
						}</span>
						<span class="usms-sig-count"></span>
					</div>
				</div>
				<div class="usms-notice usms-sig-warn"></div>
				<div class="usms-notice usms-settings-notice"></div>
				<div class="usms-actions">
					<button class="usms-btn usms-sig-reset" disabled>${__("Undo changes")}</button>
					<button class="usms-btn primary usms-sig-save" disabled><span>${__("Save signature")}</span></button>
				</div>
			</div>
			<div class="usms-balance-slot"></div>
		`);
		this.balance = new UsmsBalanceCard(this.$root.find(".usms-balance-slot"), this.console);
		this.$input = this.$root.find(".usms-signature");
		this.$save = this.$root.find(".usms-sig-save");
		this.$reset = this.$root.find(".usms-sig-reset");
	}

	// Quick inserts; the church's own name first when the site has one.
	snippets() {
		return [this.console.organisation, __("God bless you"), __("Blessings"), __("Regards")].filter(Boolean);
	}

	bind() {
		this.$input.on("input", () => this.refresh());
		// A block body on purpose: a jQuery handler that returns false cancels the
		// keypress, which is what once stopped anyone typing in this field.
		this.$input.on("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				if (!this.$save.prop("disabled")) this.save();
			}
		});
		this.$root.on("click", "[data-insert]", (e) => this.insert($(e.currentTarget).data("insert")));
		this.$root.on("click", ".usms-editor-clear", () => {
			this.$input.val("").trigger("focus");
			this.refresh();
		});
		this.$save.on("click", () => this.save());
		this.$reset.on("click", () => {
			this.$input.val(this.console.signature);
			this.refresh();
		});
	}

	on_show() {
		this.$input.val(this.console.signature);
		this.notice("");
		this.refresh();
	}

	// Mirrors ConsoleSettings.tidy: collapse spaces per line, drop blank lines.
	value() {
		return this.$input
			.val()
			.split("\n")
			.map((line) => line.replace(/\s+/g, " ").trim())
			.filter(Boolean)
			.join("\n");
	}

	insert(text) {
		const el = this.$input[0];
		const before = el.value.slice(0, el.selectionStart).replace(/[ \t]+$/, "");
		const after = el.value.slice(el.selectionEnd);
		// Each snippet goes on its own line.
		const piece = (before && !before.endsWith("\n") ? "\n" : "") + text;
		el.value = (before + piece + after).slice(0, this.console.signature_limit);
		el.focus();
		el.selectionStart = el.selectionEnd = Math.min((before + piece).length, el.value.length);
		this.refresh();
	}

	refresh() {
		const value = this.value();
		const lines = value ? value.split("\n").length : 0;
		const max_lines = this.console.signature_max_lines;
		const too_many = lines > max_lines;
		const changed = value !== this.console.signature;
		this.$input.attr("rows", Math.min(Math.max(lines, 3), 5));
		this.$root
			.find(".usms-sig-count")
			.toggleClass("over", too_many)
			.text(`${__("{0} lines", [lines])} · ${this.$input.val().length} / ${this.console.signature_limit}`);
		const special = value && !UsmsText.GSM.test(value);
		const warning = too_many
			? __("Use {0} lines or fewer.", [max_lines])
			: special
				? __("This uses an emoji or special character, so each SMS fits 70 characters instead of 160.")
				: "";
		this.$root
			.find(".usms-sig-warn")
			.attr("class", `usms-notice usms-sig-warn ${warning ? "show warn" : ""}`)
			.text(warning);
		this.$save.prop("disabled", !changed || too_many);
		this.$reset.prop("disabled", !changed);
		this.console.phone.show(__("Your message goes here."), value, __("Preview with this signature"));
	}

	notice(text, kind = "ok") {
		this.$root
			.find(".usms-settings-notice")
			.attr("class", `usms-notice usms-settings-notice ${text ? `show ${kind}` : ""}`)
			.text(text || "");
	}

	async save() {
		this.$save.addClass("loading");
		try {
			const r = await UsmsApi.call("save_signature", { signature: this.value() });
			this.console.signature = r.signature || "";
			this.$input.val(this.console.signature);
			this.notice(this.console.signature ? __("Saved. New messages will be signed.") : __("Saved. Messages go out unsigned."));
			this.refresh();
		} catch (error) {
			this.notice(error, "error");
		} finally {
			this.$save.removeClass("loading");
		}
	}
}

/** One campaign's results and recipients, instead of the desk record. */
class UsmsCampaignPanel {
	static FILTERS = ["", "Sent", "Failed", "Pending"];

	constructor($root, console) {
		this.$root = $root;
		this.console = console;
		this.$root.on("click", ".usms-back", () => this.console.switch_tab(this.console.last_tab || "bulk"));
		this.$root.on("click", "[data-filter]", (e) => this.load($(e.currentTarget).data("filter")));
		this.$root.on("click", ".usms-more", () => this.load(this.filter, true));
		this.$root.on("click", ".usms-refresh", () => this.load(this.filter));
		this.$root.on("click", ".usms-download", () =>
			window.open(
				`/api/method/upeosms.api.page.download_campaign_results?campaign_name=${encodeURIComponent(this.name)}`
			)
		);
		this.$root.on("click", ".usms-retry", (e) => this.retry($(e.currentTarget)));
		// While a campaign sends, the worker reports progress; reload at most every 2s.
		const reload = frappe.utils.throttle(() => this.load(this.filter), 2000);
		frappe.realtime.on("upeosms_campaign_progress", (data) => {
			if (data?.campaign === this.name && this.$root.hasClass("active")) reload();
		});
	}

	async retry($btn) {
		if (!$btn.hasClass("danger")) {
			$btn.addClass("danger").find("span").text(__("Confirm: send again"));
			return;
		}
		$btn.addClass("loading");
		try {
			const r = await UsmsApi.call("retry_failed_recipients", { campaign_name: this.name });
			frappe.show_alert({ message: r.message, indicator: "green" });
			this.console.load_recent();
			await this.load("");
		} catch (error) {
			$btn.removeClass("loading danger");
			this.$root.find(".usms-detail-notice").attr("class", "usms-notice usms-detail-notice show error").text(error);
		}
	}

	open(name) {
		this.name = name;
		this.$root.html(`<div class="usms-card"><div class="usms-empty">${__("Loading…")}</div></div>`);
		this.load("");
	}

	on_show() {}

	async load(filter, more = false) {
		this.filter = filter || "";
		const start = more ? this.rows.length : 0;
		try {
			const data = await UsmsApi.call("get_campaign_detail", {
				campaign_name: this.name,
				status: this.filter || null,
				start,
			});
			this.data = data;
			this.rows = more ? this.rows.concat(data.recipients) : data.recipients;
			this.render();
		} catch (error) {
			this.$root.html(`<div class="usms-card"><div class="usms-notice show error">${esc(error)}</div></div>`);
		}
	}

	render() {
		const c = this.data.campaign;
		const counts = this.data.counts || {};
		const total = Object.values(counts).reduce((a, b) => a + b, 0);
		const waiting = total - cint(counts.Sent) - cint(counts.Failed);
		const filter_total = this.filter ? cint(counts[this.filter]) : total;
		const live = ["Queued", "Sending"].includes(c.status);
		const first = this.rows.find((r) => r.rendered_message);
		this.console.phone.show(first?.rendered_message || "", "", first ? __("To {0}", [first.recipient_name || first.mobile]) : "");
		this.$root.html(`
			<div class="usms-card">
				<div class="usms-detail-top">
					<button class="usms-btn usms-back" type="button">← ${__("Back")}</button>
					<div class="usms-spacer"></div>
					${live ? `<button class="usms-btn usms-refresh" type="button">${__("Refresh")}</button>` : ""}
					<button class="usms-btn usms-download" type="button">${USMS_ICONS.download} ${__("Download results")}</button>
					${
						cint(counts.Failed) && !live
							? `<button class="usms-btn primary usms-retry" type="button">${USMS_ICONS.send} <span>${__(
									"Retry {0} failed",
									[cint(counts.Failed)]
								)}</span></button>`
							: ""
					}
				</div>
				<div class="usms-notice usms-detail-notice"></div>
				<div class="usms-detail-title">
					<div>
						<h2>${esc(c.campaign_name || c.name)}</h2>
						<p>${esc(c.name)} · ${esc(frappe.datetime.str_to_user(c.started_on || c.creation))}</p>
					</div>
					<span class="usms-status-pill ${USMS_STATUS_COLOURS[c.status] || ""}">${esc(__(c.status))}</span>
				</div>
				<div class="usms-progress"><div class="usms-progress-fill" style="width:${flt(c.progress_percent)}%"></div></div>
				<div class="usms-stats usms-stats-4">
					<div class="usms-stat"><span>${__("People")}</span><strong>${total}</strong></div>
					<div class="usms-stat sent"><span>${__("Sent")}</span><strong>${cint(counts.Sent)}</strong></div>
					<div class="usms-stat failed"><span>${__("Failed")}</span><strong>${cint(counts.Failed)}</strong></div>
					<div class="usms-stat"><span>${__("Waiting")}</span><strong>${waiting}</strong></div>
				</div>
				${
					c.message_template
						? `<div class="usms-template-box"><div class="usms-eyebrow">${__("Message")}</div>${esc(c.message_template)}</div>`
						: ""
				}
			</div>

			<div class="usms-card">
				<div class="usms-card-head">
					<div><h2>${__("Recipients")}</h2><p>${__("Showing {0} of {1}", [this.rows.length, filter_total])}</p></div>
					<div class="usms-spacer"></div>
					<div class="usms-segment">
						${UsmsCampaignPanel.FILTERS.map(
							(f) => `<button type="button" data-filter="${f}" class="${f === this.filter ? "active" : ""}">${
								f ? __(f) : __("All")
							} <em>${f ? cint(counts[f]) : total}</em></button>`
						).join("")}
					</div>
				</div>
				${this.recipients_table()}
				${
					this.rows.length < filter_total
						? `<div class="usms-actions"><button class="usms-btn usms-more" type="button">${__("Show more")}</button></div>`
						: ""
				}
			</div>
		`);
	}

	recipients_table() {
		if (!this.rows.length) return `<div class="usms-empty">${__("No one here.")}</div>`;
		const rows = this.rows
			.map(
				(r) => `<tr>
					<td class="num">${esc(r.mobile)}</td>
					<td>${esc(r.recipient_name || "")}</td>
					<td><span class="usms-status-pill ${(USMS_STATUS_COLOURS[r.status] || "").replace("live", "")}">${esc(__(r.status))}</span></td>
					<td class="usms-muted-cell">${
						r.status === "Failed"
							? `<span class="usms-error-text">${esc(r.error_message || __("Send failed"))}</span>`
							: r.sent_on
								? esc(frappe.datetime.prettyDate(r.sent_on))
								: ""
					}</td>
				</tr>`
			)
			.join("");
		return `<div class="usms-table-wrap"><table class="usms-table">
			<thead><tr><th>${__("Mobile")}</th><th>${__("Name")}</th><th>${__("Status")}</th><th>${__("Details")}</th></tr></thead>
			<tbody>${rows}</tbody></table></div>`;
	}
}

/** Every campaign, searchable, opening into its details. */
class UsmsHistoryPanel {
	static FILTERS = [
		["", __("All")],
		["Completed", __("Completed")],
		["Completed with Errors", __("With errors")],
		["Failed", __("Failed")],
		["Sending", __("Sending")],
	];

	constructor($root, console) {
		this.$root = $root;
		this.console = console;
		this.status = "";
		this.rows = [];
		this.render();
		this.$search = this.$root.find(".usms-history-search");
		this.$search.on("input", frappe.utils.debounce(() => this.load(), 300));
		this.$root.on("click", "[data-status]", (e) => {
			this.status = $(e.currentTarget).data("status");
			this.$root.find("[data-status]").removeClass("active").filter(e.currentTarget).addClass("active");
			this.load();
		});
		this.$root.on("click", ".usms-more", () => this.load(true));
		this.$root.on("click", "[data-campaign]", (e) => this.console.open_campaign($(e.currentTarget).data("campaign")));
	}

	render() {
		this.$root.html(`
			<div class="usms-card">
				<div class="usms-card-head">
					<div><h2>${__("Campaign history")}</h2><p>${__("Every message this site has sent from the console.")}</p></div>
				</div>
				<div class="usms-history-tools">
					<input class="usms-input usms-history-search" type="search" placeholder="${__("Search campaigns")}">
					<div class="usms-segment">
						${UsmsHistoryPanel.FILTERS.map(
							([value, label]) =>
								`<button type="button" data-status="${value}" class="${value === "" ? "active" : ""}">${label}</button>`
						).join("")}
					</div>
				</div>
				<div class="usms-history-list"></div>
			</div>
		`);
	}

	on_show() {
		this.load();
		this.console.phone.show("", "");
	}

	async load(more = false) {
		const start = more ? this.rows.length : 0;
		try {
			const r = await UsmsApi.call("get_campaigns", { search: this.$search.val(), status: this.status, start });
			this.rows = more ? this.rows.concat(r.campaigns) : r.campaigns;
			this.render_list(r.has_more);
		} catch (error) {
			this.$root.find(".usms-history-list").html(`<div class="usms-notice show error">${esc(error)}</div>`);
		}
	}

	render_list(has_more) {
		const $list = this.$root.find(".usms-history-list");
		if (!this.rows.length) {
			$list.html(`<div class="usms-empty">${__("No campaigns match.")}</div>`);
			return;
		}
		$list.html(`
			<div class="usms-history-grid">
				${this.rows
					.map((c) => {
						const total = cint(c.total_recipients);
						const pct = total ? Math.round((cint(c.sent_count) / total) * 100) : 0;
						return `<button type="button" class="usms-history-item" data-campaign="${esc(c.name)}">
							<div class="usms-history-row">
								<div class="usms-list-title">${esc(c.campaign_name || c.name)}</div>
								<span class="usms-status-pill ${USMS_STATUS_COLOURS[c.status] || ""}">${esc(__(c.status))}</span>
							</div>
							<div class="usms-mini-progress"><span style="width:${pct}%"></span></div>
							<div class="usms-history-row usms-list-sub">
								<span>${__("{0} of {1} sent", [cint(c.sent_count), total])}${
									cint(c.failed_count) ? ` · <b class="usms-error-text">${__("{0} failed", [cint(c.failed_count)])}</b>` : ""
								}</span>
								<span>${esc(frappe.datetime.prettyDate(c.creation))}</span>
							</div>
						</button>`;
					})
					.join("")}
			</div>
			${has_more ? `<div class="usms-actions"><button class="usms-btn usms-more" type="button">${__("Show more")}</button></div>` : ""}
		`);
	}
}

/** Every message sent, searchable by phone number or name. */
class UsmsMessagesPanel {
	static FILTERS = [
		["", __("All")],
		["Sent", __("Sent")],
		["Failed", __("Failed")],
		["Pending", __("Waiting")],
	];

	constructor($root, console) {
		this.$root = $root;
		this.console = console;
		this.status = "";
		this.rows = [];
		this.render();
		this.$search = this.$root.find(".usms-messages-search");
		this.$search.on("input", frappe.utils.debounce(() => this.load(), 300));
		this.$root.on("click", "[data-status]", (e) => {
			this.status = $(e.currentTarget).data("status");
			this.$root.find("[data-status]").removeClass("active").filter(e.currentTarget).addClass("active");
			this.load();
		});
		this.$root.on("click", ".usms-more", () => this.load(true));
		this.$root.on("click", "[data-campaign]", (e) => this.console.open_campaign($(e.currentTarget).data("campaign")));
		this.$root.on("mouseenter focusin", "[data-index]", (e) => this.preview(this.rows[$(e.currentTarget).data("index")]));
	}

	render() {
		this.$root.html(`
			<div class="usms-card">
				<div class="usms-card-head">
					<div><h2>${__("Messages")}</h2><p>${__("Find what was sent to anyone, and whether it arrived.")}</p></div>
				</div>
				<div class="usms-history-tools">
					<input class="usms-input usms-messages-search" type="search" inputmode="search"
						placeholder="${__("Search by phone number or name")}">
					<div class="usms-segment">
						${UsmsMessagesPanel.FILTERS.map(
							([value, label]) =>
								`<button type="button" data-status="${value}" class="${value === "" ? "active" : ""}">${label}</button>`
						).join("")}
					</div>
				</div>
				<div class="usms-messages-list"></div>
			</div>
		`);
	}

	on_show() {
		this.load();
	}

	async load(more = false) {
		const start = more ? this.rows.length : 0;
		try {
			const r = await UsmsApi.call("get_messages", { search: this.$search.val(), status: this.status, start });
			this.rows = more ? this.rows.concat(r.messages) : r.messages;
			this.render_list(r.has_more);
			if (!more) this.preview(this.rows[0]);
		} catch (error) {
			this.$root.find(".usms-messages-list").html(`<div class="usms-notice show error">${esc(error)}</div>`);
		}
	}

	preview(row) {
		if (!row) return this.console.phone.show("", "");
		this.console.phone.show(row.rendered_message || "", "", __("To {0}", [row.recipient_name || row.mobile]));
	}

	render_list(has_more) {
		const $list = this.$root.find(".usms-messages-list");
		if (!this.rows.length) {
			$list.html(`<div class="usms-empty">${__("No messages match.")}</div>`);
			return;
		}
		$list.html(`
			<div class="usms-message-list">
				${this.rows
					.map(
						(m, i) => `<button type="button" class="usms-message" data-index="${i}" data-campaign="${esc(m.campaign)}">
							<div class="usms-avatar usms-avatar-sm">${esc((m.recipient_name || m.mobile || "?").charAt(0).toUpperCase())}</div>
							<div class="usms-message-main">
								<div class="usms-history-row">
									<div class="usms-list-title">${esc(m.recipient_name || m.mobile)}</div>
									<span class="usms-list-sub">${esc(frappe.datetime.prettyDate(m.sent_on || m.modified))}</span>
								</div>
								<div class="usms-message-text">${esc(m.rendered_message || "")}</div>
								<div class="usms-history-row usms-list-sub">
									<span>${m.recipient_name ? `${esc(m.mobile)} · ` : ""}${esc(m.campaign_title)}</span>
									<span class="usms-status-pill ${(USMS_STATUS_COLOURS[m.status] || "").replace("live", "")}">${esc(__(m.status))}</span>
								</div>
								${m.status === "Failed" && m.error_message ? `<div class="usms-error-text usms-list-sub">${esc(m.error_message)}</div>` : ""}
							</div>
						</button>`
					)
					.join("")}
			</div>
			${has_more ? `<div class="usms-actions"><button class="usms-btn usms-more" type="button">${__("Show more")}</button></div>` : ""}
		`);
	}
}

/** The page: header, tabs, and the shared side column. */
class UpeoSmsConsole {
	constructor(wrapper) {
		this.wrapper = wrapper;
		frappe.ui.make_app_page({ parent: wrapper, single_column: true, title: __("SMS Console") });
		$(wrapper).addClass("usms-host");
		this.$body = $(wrapper).find(".layout-main-section");
		this.sender = {};
		this.signature = "";
		this.quick_send_limit = 10;
		this.signature_limit = 100;
		this.signature_max_lines = 3;
		this.organisation = "";
		this.can_edit_settings = false;
		this.load();
	}

	async load() {
		this.$body.html(`<div class="usms"><div class="usms-empty">${__("Loading…")}</div></div>`);
		try {
			const ctx = await UsmsApi.call("get_console_context");
			this.sender = ctx.sender || {};
			this.signature = ctx.signature || "";
			this.quick_send_limit = ctx.quick_send_limit || 10;
			this.signature_limit = ctx.signature_limit || 100;
			this.signature_max_lines = ctx.signature_max_lines || 3;
			this.organisation = ctx.organisation || "";
			this.balance_alerts = ctx.balance_alerts || {};
			this.can_edit_settings = !!ctx.can_edit_settings;
			this.render();
			this.recent.render(ctx.recent_campaigns);
			this.apply_route();
		} catch (error) {
			this.$body.html(`<div class="usms"><div class="usms-card"><div class="usms-empty">${esc(error)}</div></div></div>`);
		}
	}

	render() {
		const source_text = {
			own: __("this site's own account"),
			shared: __("shared account"),
			missing: __("no SMS account set up"),
		}[this.sender.source];
		this.$body.html(`
			<div class="usms">
				<header class="usms-hero">
					<div class="usms-brand">
						<div class="usms-logo">${USMS_ICONS.logo}</div>
						<div><h1>${__("Upeo SMS")}</h1><p>${__("Reach everyone with one message.")}</p></div>
					</div>
					<div class="usms-sender" title="${esc(source_text)}">
						<span class="usms-dot ${esc(this.sender.source)}"></span>
						<span>${__("Sending as")} <b>${esc(this.sender.sender_id || "—")}</b></span>
						<span class="usms-balance-pill" hidden></span>
						<button type="button" class="usms-link-btn usms-go-settings">${__("Settings")}</button>
					</div>
				</header>
				<nav class="usms-tabs">
					<button class="usms-tab active" data-tab="bulk">${__("Bulk campaign")}</button>
					<button class="usms-tab" data-tab="quick">${__("Quick send")}</button>
					<button class="usms-tab" data-tab="history">${__("History")}</button>
					<button class="usms-tab" data-tab="messages">${__("Messages")}</button>
					<button class="usms-tab" data-tab="settings">${__("Settings")}</button>
				</nav>
				<div class="usms-layout">
					<div class="usms-main">
						<section class="usms-panel active" data-panel="bulk"></section>
						<section class="usms-panel" data-panel="quick"></section>
						<section class="usms-panel" data-panel="history"></section>
						<section class="usms-panel" data-panel="messages"></section>
						<section class="usms-panel" data-panel="settings"></section>
						<section class="usms-panel" data-panel="campaign"></section>
					</div>
					<aside class="usms-side">
						<div class="usms-phone-slot"></div>
						<div class="usms-status-slot"></div>
						<div class="usms-recent-slot"></div>
					</aside>
				</div>
			</div>
		`);
		const $root = this.$body.find(".usms");
		this.show_balance(this.balance_alerts || {});
		this.phone = new UsmsPhonePreview($root.find(".usms-phone-slot"), this.sender);
		this.status = new UsmsCampaignStatus($root.find(".usms-status-slot"));
		this.status.on_finished = () => this.load_recent();
		this.recent = new UsmsRecentCampaigns($root.find(".usms-recent-slot"), (name) => this.open_campaign(name));
		$root.find(".usms-recent-slot").on("click", ".usms-see-all", () => this.switch_tab("history"));
		this.panels = {
			bulk: new UsmsBulkPanel($root.find("[data-panel=bulk]"), this),
			quick: new UsmsQuickPanel($root.find("[data-panel=quick]"), this),
			history: new UsmsHistoryPanel($root.find("[data-panel=history]"), this),
			messages: new UsmsMessagesPanel($root.find("[data-panel=messages]"), this),
			settings: new UsmsSettingsPanel($root.find("[data-panel=settings]"), this),
			campaign: new UsmsCampaignPanel($root.find("[data-panel=campaign]"), this),
		};
		$root.find(".usms-tab").on("click", (e) => this.switch_tab($(e.currentTarget).data("tab")));
		$root.on("click", ".usms-go-settings", (e) => {
			e.preventDefault();
			this.switch_tab("settings");
		});
		this.panels.bulk.on_show();
	}

	switch_tab(tab, update_path = true) {
		const $root = this.$body.find(".usms");
		if (tab !== "campaign") this.last_tab = tab;
		if (update_path && tab !== "campaign") this.set_path(tab);
		$root.find(".usms-tab").removeClass("active").filter(`[data-tab=${tab}]`).addClass("active");
		$root.find(".usms-panel").removeClass("active").filter(`[data-panel=${tab}]`).addClass("active");
		$root.find(".usms-status-slot").toggle(tab === "bulk");
		this.panels[tab].on_show();
		// Only scroll when the person is further down, so the header stays put otherwise.
		if ($root.find(".usms-main")[0].getBoundingClientRect().top < 0) window.scrollTo({ top: 0, behavior: "smooth" });
	}

	/**
	 * The view lives in the path: /bulk-sms-console/<tab> or
	 * /bulk-sms-console/campaign/<name>, so desk redirects and bookmarks land
	 * on the right screen.
	 */
	apply_route() {
		if (!this.panels) return;
		const [, view, name] = frappe.get_route();
		if (view === "campaign" && name) this.open_campaign(name, false);
		else if (this.panels[view] && view !== "campaign") this.switch_tab(view, false);
	}

	// Keep the address bar in step without adding history entries.
	set_path(...parts) {
		const base = window.location.pathname.split("/").slice(0, 3).join("/");
		const path = [base, ...parts.map(encodeURIComponent)].join("/");
		if (path !== window.location.pathname) window.history.replaceState(window.history.state, "", path);
	}

	open_campaign(name, update_path = true) {
		this.switch_tab("campaign", false);
		this.panels.campaign.open(name);
		if (update_path) this.set_path("campaign", name);
	}

	show_balance(state) {
		const $pill = this.$body.find(".usms-balance-pill");
		if (state.balance === null || state.balance === undefined || !state.checked_on) return $pill.prop("hidden", true);
		const low = (state.thresholds || []).some((level) => state.balance <= level);
		$pill
			.prop("hidden", false)
			.toggleClass("low", low)
			.attr("title", __("Checked {0}", [frappe.datetime.prettyDate(state.checked_on)]))
			.text(__("{0} units", [format_number(state.balance, null, 0)]));
	}

	signature_note() {
		return this.signature
			? __("Signed {0} automatically", [`<b>${esc(this.signature.split("\n").join(" · "))}</b>`])
			: `${__("No signature")} · <a href="#" class="usms-go-settings">${__("add one")}</a>`;
	}

	async load_recent() {
		try {
			const ctx = await UsmsApi.call("get_console_context");
			this.recent.render(ctx.recent_campaigns);
		} catch (e) {
			console.error(e);
		}
	}
}
