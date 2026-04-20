import json

import frappe
from frappe import _

from upeosms.tasks import enqueue_campaign_send
from upeosms.utils.file_parser import read_uploaded_rows
from upeosms.utils.template import extract_variables, render_message

@frappe.whitelist()
def create_campaign(campaign_name=None, upload_file=None, message_template=None):
    if not upload_file:
        frappe.throw(_("Please upload a file."))

    doc = frappe.get_doc({
        "doctype": "SMS Campaign",
        "campaign_name": campaign_name or "SMS Campaign",
        "upload_file": upload_file,
        "message_template": message_template or "",
        "status": "Draft",
    }).insert(ignore_permissions=True)

    return {"campaign": doc.name}

@frappe.whitelist()
def parse_campaign(campaign_name):
    campaign = frappe.get_doc("SMS Campaign", campaign_name)

    if campaign.status in ["Queued", "Sending", "Completed"]:
        frappe.throw(_("You cannot parse this campaign in its current state."))

    rows, columns = read_uploaded_rows(campaign.upload_file)

    _validate_template_against_columns(campaign.message_template, columns)
    _rebuild_recipients(campaign, rows)

    preview = _build_preview(rows, campaign.message_template, 5)

    campaign.db_set({
        "detected_columns": json.dumps(columns),
        "preview_json": json.dumps(preview, default=str),
        "total_recipients": len(rows),
        "status": "Ready",
    })

    frappe.db.commit()

    return {
        "campaign": campaign.name,
        "columns": columns,
        "preview": preview,
        "count": len(rows),
    }

@frappe.whitelist()
def start_campaign(campaign_name):
    campaign = frappe.get_doc("SMS Campaign", campaign_name)

    if campaign.status not in ["Ready", "Failed", "Completed with Errors"]:
        frappe.throw(_("Campaign must be Ready before sending."))

    count = frappe.db.count("SMS Recipient", {"campaign": campaign.name})
    if not count:
        frappe.throw(_("No recipients found. Parse the file first."))

    frappe.db.set_value("SMS Campaign", campaign.name, {
        "status": "Queued",
        "queued_count": count,
        "sent_count": 0,
        "failed_count": 0,
        "progress_percent": 0,
        "started_on": frappe.utils.now(),
        "completed_on": None,
        "last_error": None,
    })

    frappe.db.set_value(
        "SMS Recipient",
        {"campaign": campaign.name},
        "status",
        "Pending",
        update_modified=False,
    )

    enqueue_campaign_send(campaign.name)
    frappe.db.commit()

    return {"message": "Campaign queued successfully.", "campaign": campaign.name}

@frappe.whitelist()
def retry_failed(campaign_name):
    campaign = frappe.get_doc("SMS Campaign", campaign_name)

    failed = frappe.get_all(
        "SMS Recipient",
        filters={"campaign": campaign.name, "status": "Failed"},
        fields=["name"]
    )

    if not failed:
        frappe.throw(_("There are no failed messages to retry."))

    for row in failed:
        frappe.db.set_value("SMS Recipient", row.name, "status", "Pending", update_modified=False)

    frappe.db.set_value("SMS Campaign", campaign.name, "status", "Ready")
    frappe.db.commit()

    return {"message": "Failed messages reset to pending."}

@frappe.whitelist()
def get_campaign(campaign_name):
    campaign = frappe.get_doc("SMS Campaign", campaign_name)
    return {
        "name": campaign.name,
        "campaign_name": campaign.campaign_name,
        "upload_file": campaign.upload_file,
        "message_template": campaign.message_template,
        "status": campaign.status,
        "detected_columns": json.loads(campaign.detected_columns or "[]"),
        "preview": json.loads(campaign.preview_json or "[]"),
        "total": campaign.total_recipients,
        "queued": campaign.queued_count,
        "sent": campaign.sent_count,
        "failed": campaign.failed_count,
        "progress_percent": campaign.progress_percent,
    }

@frappe.whitelist()
def get_recent_campaigns(limit=20):
    return frappe.get_all(
        "SMS Campaign",
        fields=[
            "name",
            "campaign_name",
            "status",
            "total_recipients",
            "sent_count",
            "failed_count",
            "progress_percent",
            "creation",
        ],
        order_by="creation desc",
        limit_page_length=int(limit),
    )

def _validate_template_against_columns(template, columns):
    variables = extract_variables(template or "")
    missing = [v for v in variables if v not in columns]
    if missing:
        frappe.throw(_("These variables are missing in the file: {0}").format(", ".join(missing)))

def _rebuild_recipients(campaign, rows):
    old_rows = frappe.get_all("SMS Recipient", filters={"campaign": campaign.name}, pluck="name")
    for row_name in old_rows:
        frappe.delete_doc("SMS Recipient", row_name, force=1)

    for idx, row in enumerate(rows, start=1):
        recipient_name = row.get("name") or row.get("full_name") or row.get("customer_name") or ""
        rendered = render_message(campaign.message_template or "", row)

        frappe.get_doc({
            "doctype": "SMS Recipient",
            "campaign": campaign.name,
            "row_index": idx,
            "mobile": row.get("mobile"),
            "recipient_name": recipient_name,
            "row_data_json": json.dumps(row, default=str),
            "rendered_message": rendered,
            "status": "Pending",
        }).insert(ignore_permissions=True)

def _build_preview(rows, template, limit=5):
    out = []
    for row in rows[:limit]:
        out.append({
            "row": row,
            "message": render_message(template or "", row),
        })
    return out