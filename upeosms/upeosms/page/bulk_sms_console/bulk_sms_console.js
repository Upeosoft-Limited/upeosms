frappe.provide("upeosms.bulk_sms");

frappe.pages['bulk-sms-console'].on_page_load = function(wrapper) {
	new UpeoBulkSMSPage(wrapper);
};

class UpeoBulkSMSPage {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.page = frappe.ui.make_app_page({
			parent: wrapper,
			single_column: true,
		});

		this.campaign_name = null;
		this.detected_columns = [];
		this.realtime_event = null;
		this.preview_rows = [];
		this.init();
	}

	init() {
		this.render();
		this.bind_events();
		this.load_defaults();
	}

	render() {
		$(this.page.body).html(`
			<div class="upeosms-page">
				<div class="upeosms-topbar">
					<div class="upeosms-topbar-left">
						<div class="upeosms-title">Bulk SMS Console</div>
						<div class="upeosms-subtitle">
							Upload recipients, compose a variable-based message, preview, queue, and monitor delivery in real time.
						</div>
					</div>
					<div class="upeosms-topbar-right">
						<button class="btn btn-default" id="upeosms-new-campaign-btn">New Campaign</button>
						<button class="btn btn-primary" id="upeosms-start-btn" disabled>Start Sending</button>
					</div>
				</div>

				<div class="upeosms-grid">
					<div class="upeosms-card upeosms-main-card">
						<div class="upeosms-card-title">Campaign Setup</div>

						<div class="upeosms-field-grid">
							<div class="upeosms-field">
								<label>Campaign Name</label>
								<input type="text" class="form-control" id="upeosms-campaign-name" placeholder="e.g. Customer Balance Reminder - April 2026">
							</div>

							<div class="upeosms-field">
								<label>Upload CSV / XLSX</label>
								<div class="upeosms-upload-row">
									<input type="file" id="upeosms-file" accept=".csv,.xlsx">
									<button class="btn btn-default" id="upeosms-upload-btn">Upload & Parse</button>
								</div>
								<div class="upeosms-help">
									Required column: <code>mobile</code>. Other columns become variables such as <code>{name}</code>, <code>{balance}</code>.
								</div>
							</div>
						</div>

						<div class="upeosms-card-subsection">
							<div class="upeosms-inline-title">Detected Variables</div>
							<div id="upeosms-variable-box" class="upeosms-chip-box">
								<div class="upeosms-empty-text">No variables yet. Upload a file first.</div>
							</div>
						</div>

						<div class="upeosms-card-subsection">
							<div class="upeosms-inline-title">Message Template</div>
							<textarea
								id="upeosms-message-template"
								class="form-control upeosms-textarea"
								placeholder="Type your SMS here. Example: Hi {name}, your current balance is KES {balance}."
							></textarea>
							<div class="upeosms-help">
								Click any variable above to insert it at the cursor position.
							</div>
						</div>

						<div class="upeosms-actions">
							<button class="btn btn-default" id="upeosms-preview-btn" disabled>Generate Preview</button>
							<button class="btn btn-default" id="upeosms-refresh-progress-btn" disabled>Refresh Progress</button>
						</div>
					</div>

					<div class="upeosms-card upeosms-status-card">
						<div class="upeosms-card-title">Live Status</div>

						<div class="upeosms-stats">
							<div class="upeosms-stat-box">
								<div class="upeosms-stat-label">Status</div>
								<div class="upeosms-stat-value" id="upeosms-status">Draft</div>
							</div>
							<div class="upeosms-stat-box">
								<div class="upeosms-stat-label">Total</div>
								<div class="upeosms-stat-value" id="upeosms-total">0</div>
							</div>
							<div class="upeosms-stat-box">
								<div class="upeosms-stat-label">Queued</div>
								<div class="upeosms-stat-value" id="upeosms-queued">0</div>
							</div>
							<div class="upeosms-stat-box">
								<div class="upeosms-stat-label">Sent</div>
								<div class="upeosms-stat-value upeosms-success" id="upeosms-sent">0</div>
							</div>
							<div class="upeosms-stat-box">
								<div class="upeosms-stat-label">Failed</div>
								<div class="upeosms-stat-value upeosms-failed" id="upeosms-failed">0</div>
							</div>
						</div>

						<div class="upeosms-progress-wrap">
							<div class="upeosms-progress-header">
								<span>Progress</span>
								<span id="upeosms-progress-label">0%</span>
							</div>
							<div class="upeosms-progress-bar">
								<div class="upeosms-progress-fill" id="upeosms-progress-fill"></div>
							</div>
						</div>

						<div class="upeosms-stream" id="upeosms-stream">
							<div class="upeosms-empty-text">No activity yet.</div>
						</div>
					</div>
				</div>

				<div class="upeosms-card">
					<div class="upeosms-card-title">Preview</div>
					<div class="upeosms-preview-toolbar">
						<div class="upeosms-help">
							Preview the first few rendered messages before queueing.
						</div>
					</div>
					<div id="upeosms-preview-table-wrap">
						<div class="upeosms-empty-text">No preview yet.</div>
					</div>
				</div>
			</div>
		`);

		this.inject_styles();
		this.cache_dom();
	}

	cache_dom() {
		this.$campaign_name = $("#upeosms-campaign-name");
		this.$file = $("#upeosms-file");
		this.$upload_btn = $("#upeosms-upload-btn");
		this.$message_template = $("#upeosms-message-template");
		this.$variable_box = $("#upeosms-variable-box");
		this.$preview_btn = $("#upeosms-preview-btn");
		this.$start_btn = $("#upeosms-start-btn");
		this.$new_campaign_btn = $("#upeosms-new-campaign-btn");
		this.$refresh_progress_btn = $("#upeosms-refresh-progress-btn");
		this.$preview_table_wrap = $("#upeosms-preview-table-wrap");

		this.$status = $("#upeosms-status");
		this.$total = $("#upeosms-total");
		this.$queued = $("#upeosms-queued");
		this.$sent = $("#upeosms-sent");
		this.$failed = $("#upeosms-failed");
		this.$progress_fill = $("#upeosms-progress-fill");
		this.$progress_label = $("#upeosms-progress-label");
		this.$stream = $("#upeosms-stream");
	}

	inject_styles() {
		if ($("#upeosms-page-styles").length) return;

		$("head").append(`
			<style id="upeosms-page-styles">
				.upeosms-page {
					padding: 18px;
					background: #f7f8fa;
					min-height: calc(100vh - 90px);
				}

				.upeosms-topbar {
					display: flex;
					align-items: flex-start;
					justify-content: space-between;
					gap: 16px;
					margin-bottom: 18px;
				}

				.upeosms-title {
					font-size: 24px;
					font-weight: 700;
					color: #1f272e;
					margin-bottom: 4px;
				}

				.upeosms-subtitle {
					font-size: 14px;
					color: #68727d;
					max-width: 760px;
					line-height: 1.5;
				}

				.upeosms-topbar-right {
					display: flex;
					gap: 10px;
					flex-wrap: wrap;
				}

				.upeosms-grid {
					display: grid;
					grid-template-columns: 1.5fr 1fr;
					gap: 18px;
					margin-bottom: 18px;
				}

				.upeosms-card {
					background: #fff;
					border-radius: 16px;
					padding: 18px;
					box-shadow: 0 2px 14px rgba(0, 0, 0, 0.04);
					border: 1px solid #eef1f4;
				}

				.upeosms-card-title {
					font-size: 18px;
					font-weight: 700;
					color: #1f272e;
					margin-bottom: 14px;
				}

				.upeosms-inline-title {
					font-size: 14px;
					font-weight: 600;
					margin-bottom: 8px;
					color: #36414c;
				}

				.upeosms-field-grid {
					display: grid;
					grid-template-columns: 1fr;
					gap: 14px;
				}

				.upeosms-field label {
					display: block;
					font-size: 13px;
					font-weight: 600;
					color: #36414c;
					margin-bottom: 6px;
				}

				.upeosms-upload-row {
					display: flex;
					gap: 10px;
					flex-wrap: wrap;
					align-items: center;
				}

				.upeosms-help {
					font-size: 12px;
					color: #7c8792;
					margin-top: 6px;
					line-height: 1.45;
				}

				.upeosms-card-subsection {
					margin-top: 18px;
				}

				.upeosms-chip-box {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
					min-height: 42px;
				}

				.upeosms-chip {
					border: 1px solid #dbe2ea;
					background: #f8fafc;
					color: #2f3a44;
					padding: 8px 12px;
					border-radius: 999px;
					font-size: 12px;
					font-weight: 600;
					cursor: pointer;
					transition: all 0.15s ease;
				}

				.upeosms-chip:hover {
					background: #eef4ff;
					border-color: #b7cdfb;
				}

				.upeosms-textarea {
					min-height: 170px;
					resize: vertical;
					font-size: 14px;
					line-height: 1.6;
				}

				.upeosms-actions {
					display: flex;
					gap: 10px;
					margin-top: 18px;
					flex-wrap: wrap;
				}

				.upeosms-stats {
					display: grid;
					grid-template-columns: repeat(2, 1fr);
					gap: 10px;
				}

				.upeosms-stat-box {
					border: 1px solid #edf1f5;
					border-radius: 14px;
					padding: 12px;
					background: #fbfcfd;
				}

				.upeosms-stat-label {
					font-size: 12px;
					color: #7b8794;
					margin-bottom: 6px;
				}

				.upeosms-stat-value {
					font-size: 20px;
					font-weight: 700;
					color: #27313a;
				}

				.upeosms-success {
					color: #138a36;
				}

				.upeosms-failed {
					color: #c92a2a;
				}

				.upeosms-progress-wrap {
					margin-top: 16px;
				}

				.upeosms-progress-header {
					display: flex;
					justify-content: space-between;
					font-size: 13px;
					font-weight: 600;
					color: #4b5560;
					margin-bottom: 8px;
				}

				.upeosms-progress-bar {
					width: 100%;
					height: 12px;
					background: #edf1f5;
					border-radius: 999px;
					overflow: hidden;
				}

				.upeosms-progress-fill {
					height: 100%;
					width: 0%;
					background: linear-gradient(90deg, #4e8df5, #7aa8ff);
					transition: width 0.3s ease;
				}

				.upeosms-stream {
					margin-top: 16px;
					background: #fbfcfd;
					border: 1px solid #edf1f5;
					border-radius: 14px;
					padding: 12px;
					max-height: 250px;
					overflow: auto;
				}

				.upeosms-stream-item {
					padding: 8px 0;
					border-bottom: 1px solid #edf1f5;
					font-size: 13px;
					color: #46505a;
				}

				.upeosms-stream-item:last-child {
					border-bottom: none;
				}

				.upeosms-preview-toolbar {
					margin-bottom: 10px;
				}

				.upeosms-preview-table {
					width: 100%;
					border-collapse: collapse;
				}

				.upeosms-preview-table th,
				.upeosms-preview-table td {
					border-bottom: 1px solid #edf1f5;
					padding: 10px 8px;
					text-align: left;
					vertical-align: top;
					font-size: 13px;
				}

				.upeosms-preview-table th {
					color: #5e6975;
					font-weight: 700;
					background: #fafbfd;
				}

				.upeosms-empty-text {
					font-size: 13px;
					color: #8a95a0;
					padding: 8px 0;
				}

				@media (max-width: 992px) {
					.upeosms-grid {
						grid-template-columns: 1fr;
					}
				}
			</style>
		`);
	}

	bind_events() {
		this.$new_campaign_btn.on("click", () => this.reset_page());
		this.$upload_btn.on("click", () => this.upload_and_parse());
		this.$preview_btn.on("click", () => this.generate_preview());
		this.$start_btn.on("click", () => this.start_sending());
		this.$refresh_progress_btn.on("click", () => this.refresh_progress());
	}

	

	load_defaults() {
		this.reset_stats();
	}

	reset_page() {
		this.campaign_name = null;
		this.detected_columns = [];
		this.preview_rows = [];

		this.$campaign_name.val("");
		this.$file.val("");
		this.$message_template.val("");
		this.render_variable_chips();
		this.render_preview([]);
		this.reset_stats();
		this.append_stream("New campaign started.");
		this.toggle_actions(false);
		this.unsubscribe_realtime();
	}

	toggle_actions(enabled) {
		this.$preview_btn.prop("disabled", !enabled);
		this.$start_btn.prop("disabled", !enabled);
		this.$refresh_progress_btn.prop("disabled", !enabled);
		this.page.btn_primary.prop("disabled", !enabled);
	}

	reset_stats() {
		this.update_stats({
			status: "Draft",
			total: 0,
			queued: 0,
			sent: 0,
			failed: 0,
			progress_percent: 0,
		});
	}

	append_stream(message) {
		const timestamp = frappe.datetime.now_time();
		const empty = this.$stream.find(".upeosms-empty-text");
		if (empty.length) empty.remove();

		this.$stream.prepend(`
			<div class="upeosms-stream-item">
				<span style="color:#7b8794;">[${timestamp}]</span> ${frappe.utils.escape_html(message)}
			</div>
		`);
	}

	render_variable_chips() {
		if (!this.detected_columns.length) {
			this.$variable_box.html(`<div class="upeosms-empty-text">No variables yet. Upload a file first.</div>`);
			return;
		}

		this.$variable_box.empty();

		this.detected_columns.forEach((col) => {
			const $chip = $(`<button class="upeosms-chip" type="button">{${frappe.utils.escape_html(col)}}</button>`);
			$chip.on("click", () => this.insert_variable(`{${col}}`));
			this.$variable_box.append($chip);
		});
	}

	insert_variable(text) {
		const input = this.$message_template.get(0);
		if (!input) return;

		const start = input.selectionStart || 0;
		const end = input.selectionEnd || 0;
		const value = input.value || "";

		const updated = value.substring(0, start) + text + value.substring(end);
		this.$message_template.val(updated);

		setTimeout(() => {
			input.focus();
			input.selectionStart = input.selectionEnd = start + text.length;
		}, 0);
	}

	async upload_and_parse() {
		const campaign_name = (this.$campaign_name.val() || "").trim();
		const file = this.$file.get(0)?.files?.[0];
		const message_template = (this.$message_template.val() || "").trim();

		if (!campaign_name) {
			frappe.msgprint("Enter a campaign name first.");
			return;
		}

		if (!file) {
			frappe.msgprint("Please choose a CSV or XLSX file.");
			return;
		}

		try {
			frappe.dom.freeze("Uploading and parsing file...");

			const file_doc = await this.upload_file(file);

			const r = await frappe.call({
				method: "upeosms.api.page.create_or_update_campaign_from_page",
				args: {
					campaign_name,
					file_url: file_doc.file_url,
					message_template,
				},
			});

			const data = r.message || {};
			this.campaign_name = data.campaign;
			this.detected_columns = data.columns || [];
			this.preview_rows = data.preview || [];

			this.render_variable_chips();
			this.render_preview(this.preview_rows);
			this.update_stats({
				status: data.status || "Ready",
				total: data.total || 0,
				queued: 0,
				sent: 0,
				failed: 0,
				progress_percent: 0,
			});

			this.subscribe_realtime();
			this.toggle_actions(true);
			this.append_stream(`File parsed successfully. ${data.total || 0} recipients loaded.`);
			frappe.show_alert({ message: "File parsed successfully.", indicator: "green" });
		} catch (e) {
			this.handle_error(e);
		} finally {
			frappe.dom.unfreeze();
		}
	}


	upload_file(file) {
		return new Promise((resolve, reject) => {
			const form_data = new FormData();
			form_data.append("file", file, file.name);
			form_data.append("is_private", 1);

			$.ajax({
				url: "/api/method/upload_file",
				type: "POST",
				data: form_data,
				processData: false,
				contentType: false,
				headers: {
					"X-Frappe-CSRF-Token": frappe.csrf_token,
				},
				success: function (r) {
					if (r && r.message) {
						resolve(r.message);
					} else {
						reject("File upload failed.");
					}
				},
				error: function (xhr) {
					let msg = "File upload failed.";
					if (xhr?.responseJSON?.message) {
						msg = xhr.responseJSON.message;
					}
					reject(msg);
				},
			});
		});
	}

	

	async generate_preview() {
		const message_template = (this.$message_template.val() || "").trim();

		if (!this.campaign_name) {
			frappe.msgprint("Upload and parse a file first.");
			return;
		}

		if (!message_template) {
			frappe.msgprint("Enter the message template first.");
			return;
		}

		try {
			frappe.dom.freeze("Generating preview...");

			const r = await frappe.call({
				method: "upeosms.api.page.generate_preview_from_page",
				args: {
					campaign_name: this.campaign_name,
					message_template,
				},
			});

			this.preview_rows = r.message?.preview || [];
			this.render_preview(this.preview_rows);
			this.append_stream("Preview generated.");
			frappe.show_alert({ message: "Preview generated.", indicator: "green" });
		} catch (e) {
			this.handle_error(e);
		} finally {
			frappe.dom.unfreeze();
		}
	}

	render_preview(rows) {
		if (!rows || !rows.length) {
			this.$preview_table_wrap.html(`<div class="upeosms-empty-text">No preview yet.</div>`);
			return;
		}

		const html = `
			<div style="overflow:auto;">
				<table class="upeosms-preview-table">
					<thead>
						<tr>
							<th style="width:60px;">#</th>
							<th style="width:180px;">Mobile</th>
							<th style="width:180px;">Name</th>
							<th>Rendered Message</th>
						</tr>
					</thead>
					<tbody>
						${rows
							.map((row, index) => {
								const data = row.data || {};
								return `
									<tr>
										<td>${index + 1}</td>
										<td>${frappe.utils.escape_html(cstr(data.mobile || ""))}</td>
										<td>${frappe.utils.escape_html(cstr(data.name || data.full_name || ""))}</td>
										<td>${frappe.utils.escape_html(cstr(row.message || ""))}</td>
									</tr>
								`;
							})
							.join("")}
					</tbody>
				</table>
			</div>
		`;

		this.$preview_table_wrap.html(html);
	}

	async start_sending() {
		const message_template = (this.$message_template.val() || "").trim();

		if (!this.campaign_name) {
			frappe.msgprint("Upload and parse a file first.");
			return;
		}

		if (!message_template) {
			frappe.msgprint("Enter the message template first.");
			return;
		}

		try {
			frappe.dom.freeze("Queueing SMS...");

			const r = await frappe.call({
				method: "upeosms.api.page.start_campaign_from_page",
				args: {
					campaign_name: this.campaign_name,
					message_template,
				},
			});

			const msg = r.message?.message || "Campaign queued successfully.";
			this.append_stream(msg);
			frappe.show_alert({ message: msg, indicator: "green" });

			await this.refresh_progress();
			this.subscribe_realtime();
		} catch (e) {
			this.handle_error(e);
		} finally {
			frappe.dom.unfreeze();
		}
	}

	async refresh_progress() {
		if (!this.campaign_name) return;

		try {
			const r = await frappe.call({
				method: "upeosms.api.page.get_campaign_progress_from_page",
				args: {
					campaign_name: this.campaign_name,
				},
			});

			this.update_stats(r.message || {});
		} catch (e) {
			this.handle_error(e);
		}
	}

	update_stats(data) {
		const status = data.status || "Draft";
		const total = cint(data.total || 0);
		const queued = cint(data.queued || 0);
		const sent = cint(data.sent || 0);
		const failed = cint(data.failed || 0);
		const progress = flt(data.progress_percent || 0, 2);

		this.$status.text(status);
		this.$total.text(total);
		this.$queued.text(queued);
		this.$sent.text(sent);
		this.$failed.text(failed);
		this.$progress_fill.css("width", `${progress}%`);
		this.$progress_label.text(`${progress}%`);
	}

	subscribe_realtime() {
		if (!this.campaign_name) return;

		this.unsubscribe_realtime();

		this.realtime_event = `upeosms_progress_${this.campaign_name}`;

		frappe.realtime.on(this.realtime_event, (data) => {
			this.update_stats(data || {});
			this.append_stream(
				`Progress update — Sent: ${cint(data?.sent || 0)}, Failed: ${cint(data?.failed || 0)}, Queued: ${cint(data?.queued || 0)}, Progress: ${flt(data?.progress_percent || 0, 2)}%`
			);
		});
	}

	unsubscribe_realtime() {
		if (this.realtime_event) {
			frappe.realtime.off(this.realtime_event);
			this.realtime_event = null;
		}
	}

	handle_error(error) {
		console.error(error);

		let message = "Something went wrong.";

		if (error?.message) {
			message = error.message;
		} else if (typeof error === "string") {
			message = error;
		}

		frappe.msgprint({
			title: "Error",
			message,
			indicator: "red",
		});

		this.append_stream(`Error: ${message}`);
	}
}