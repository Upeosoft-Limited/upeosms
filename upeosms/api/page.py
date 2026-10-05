import json

import frappe
from frappe import _

from upeosms.services.campaign_history import CampaignHistory
from upeosms.services.campaign_report import CampaignReport
from upeosms.services.campaign_retry import CampaignRetry
from upeosms.services.console_settings import ConsoleSettings
from upeosms.services.message_composer import MessageComposer
from upeosms.services.quick_send import QuickSend
from upeosms.services.sample_file import SampleRecipientFile
from upeosms.services.sender_profile import SenderProfile
from upeosms.tasks import enqueue_campaign_send
from upeosms.utils.file_parser import read_uploaded_rows
from upeosms.utils.template import extract_variables

RECENT_CAMPAIGNS = 6


@frappe.whitelist()
def get_console_context():
    _require_sms_access()
    return {
        "sender": SenderProfile.for_current_site().as_dict(),
        "signature": MessageComposer.from_settings().signature,
        "quick_send_limit": QuickSend.LIMIT,
        "signature_limit": ConsoleSettings.MAX_SIGNATURE,
        "can_edit_settings": bool(frappe.has_permission("UPEOSMS Settings", "write")),
        "recent_campaigns": frappe.get_all(
            "SMS Campaign",
            fields=["name", "campaign_name", "status", "total_recipients", "sent_count", "failed_count", "creation"],
            order_by="creation desc",
            limit_page_length=RECENT_CAMPAIGNS,
        ),
    }


@frappe.whitelist()
def quick_send(numbers: str, message: str):
    _require_sms_access()
    return QuickSend(numbers, message, MessageComposer.from_settings()).send()


@frappe.whitelist()
def save_signature(signature: str | None = None):
    _require_sms_access()
    return {"signature": ConsoleSettings().save_signature(signature)}


@frappe.whitelist()
def get_campaign_detail(campaign_name: str, status: str | None = None, start: int = 0):
    _require_sms_access()
    return CampaignReport(campaign_name).as_dict(status=status, start=start)


@frappe.whitelist()
def get_campaigns(search: str | None = None, status: str | None = None, start: int = 0):
    _require_sms_access()
    return CampaignHistory(search, status).page(start)


@frappe.whitelist()
def retry_failed_recipients(campaign_name: str):
    _require_sms_access()
    count = CampaignRetry(campaign_name).run()
    return {"message": _("Sending again to {0} people.").format(count)}


@frappe.whitelist()
def download_campaign_results(campaign_name: str):
    _require_sms_access()
    report = CampaignReport(campaign_name)
    frappe.response["filename"] = report.results_filename
    frappe.response["filecontent"] = report.results_xlsx()
    frappe.response["type"] = "binary"


@frappe.whitelist()
def download_sample_file():
    _require_sms_access()
    sample = SampleRecipientFile()
    frappe.response["filename"] = sample.FILENAME
    frappe.response["filecontent"] = sample.as_xlsx()
    frappe.response["type"] = "binary"


@frappe.whitelist()
def create_or_update_campaign_from_page(campaign_name: str, file_url: str, message_template: str | None = None):
    _require_sms_access()
    campaign_name = (campaign_name or "").strip()
    file_url = (file_url or "").strip()
    message_template = message_template or ""

    if not campaign_name:
        frappe.throw(_("Campaign name is required."))

    if not file_url:
        frappe.throw(_("Uploaded file is required."))

    campaign = _get_or_create_campaign(campaign_name)
    campaign.upload_file = file_url
    campaign.message_template = message_template
    campaign.status = "Draft"
    campaign.save(ignore_permissions=True)

    rows, columns = read_uploaded_rows(file_url)

    _validate_template_variables(message_template, columns)
    _rebuild_recipients(campaign, rows, message_template)

    preview = _build_preview(rows, message_template)

    campaign.detected_columns = json.dumps(columns, indent=2)
    campaign.preview_json = json.dumps(preview, indent=2, default=str)
    campaign.total_recipients = len(rows)
    campaign.queued_count = 0
    campaign.sent_count = 0
    campaign.failed_count = 0
    campaign.progress_percent = 0
    campaign.status = "Ready"
    campaign.last_error = None
    campaign.save(ignore_permissions=True)

    frappe.db.commit()

    return {
        "campaign": campaign.name,
        "status": campaign.status,
        "columns": columns,
        "total": len(rows),
        "preview": preview,
    }


@frappe.whitelist()
def generate_preview_from_page(campaign_name: str, message_template: str):
    _require_sms_access()
    campaign_name = (campaign_name or "").strip()
    message_template = message_template or ""

    if not campaign_name:
        frappe.throw(_("Campaign name is required."))

    campaign = frappe.get_doc("SMS Campaign", campaign_name)

    if not campaign.upload_file:
        frappe.throw(_("No uploaded file found for this campaign."))

    rows, columns = read_uploaded_rows(campaign.upload_file)
    _validate_template_variables(message_template, columns)

    preview = _build_preview(rows, message_template)

    campaign.message_template = message_template
    campaign.preview_json = json.dumps(preview, indent=2, default=str)
    campaign.save(ignore_permissions=True)

    _update_recipient_messages(campaign.name, message_template)

    frappe.db.commit()

    return {
        "campaign": campaign.name,
        "preview": preview,
    }


@frappe.whitelist()
def start_campaign_from_page(campaign_name: str, message_template: str):
    _require_sms_access()
    campaign_name = (campaign_name or "").strip()
    message_template = message_template or ""

    if not campaign_name:
        frappe.throw(_("Campaign name is required."))

    campaign = frappe.get_doc("SMS Campaign", campaign_name)

    if not campaign.upload_file:
        frappe.throw(_("Please upload a file first."))

    rows, columns = read_uploaded_rows(campaign.upload_file)
    _validate_template_variables(message_template, columns)

    campaign.message_template = message_template
    campaign.started_on = frappe.utils.now()
    campaign.completed_on = None
    campaign.last_error = None
    campaign.save(ignore_permissions=True)

    _update_recipient_messages(campaign.name, message_template)

    recipient_names = frappe.get_all(
        "SMS Recipient",
        filters={"campaign": campaign.name},
        pluck="name",
    )

    if not recipient_names:
        frappe.throw(_("No recipients found for this campaign."))

    frappe.db.sql("""
        update `tabSMS Recipient`
        set status = 'Pending',
            error_message = null
        where campaign = %s
          and status != 'Sent'
    """, (campaign.name,))

    frappe.db.set_value(
        "SMS Campaign",
        campaign.name,
        {
            "status": "Queued",
            "queued_count": len(recipient_names),
            "sent_count": frappe.db.count("SMS Recipient", {"campaign": campaign.name, "status": "Sent"}),
            "failed_count": 0,
            "progress_percent": 0,
        },
    )

    frappe.db.commit()
    enqueue_campaign_send(campaign.name)

    return {
        "message": _("Campaign queued successfully."),
        "campaign": campaign.name,
    }


@frappe.whitelist()
def get_campaign_progress_from_page(campaign_name: str):
    _require_sms_access()
    campaign_name = (campaign_name or "").strip()

    if not campaign_name:
        frappe.throw(_("Campaign name is required."))

    campaign = frappe.get_doc("SMS Campaign", campaign_name)

    return {
        "status": campaign.status,
        "total": campaign.total_recipients or 0,
        "queued": campaign.queued_count or 0,
        "sent": campaign.sent_count or 0,
        "failed": campaign.failed_count or 0,
        "progress_percent": campaign.progress_percent or 0,
    }


def _require_sms_access():
    # These endpoints save with ignore_permissions and send SMS, so check here
    # that the caller may run campaigns at all (System Manager by default).
    if not frappe.has_permission("SMS Campaign", "create"):
        frappe.throw(_("You are not allowed to send SMS."), frappe.PermissionError)


def _get_or_create_campaign(campaign_name: str):
    existing = frappe.db.exists("SMS Campaign", campaign_name)
    if existing:
        return frappe.get_doc("SMS Campaign", campaign_name)

    doc = frappe.get_doc({
        "doctype": "SMS Campaign",
        "campaign_name": campaign_name,
        "title": campaign_name if frappe.get_meta("SMS Campaign").has_field("title") else None,
    })

    if frappe.get_meta("SMS Campaign").autoname == "prompt":
        doc.name = campaign_name

    doc.insert(ignore_permissions=True)
    return doc


def _rebuild_recipients(campaign, rows, message_template: str):
    existing = frappe.get_all("SMS Recipient", filters={"campaign": campaign.name}, pluck="name")
    for row_name in existing:
        frappe.delete_doc("SMS Recipient", row_name, force=1)

    composer = MessageComposer.from_settings()
    for idx, row in enumerate(rows, start=1):
        rendered_message = composer.compose(message_template, row)
        recipient_name = row.get("name") or row.get("full_name") or ""

        frappe.get_doc({
            "doctype": "SMS Recipient",
            "campaign": campaign.name,
            "row_index": idx,
            "mobile": cstr(row.get("mobile")).strip() if row.get("mobile") is not None else "",
            "recipient_name": recipient_name,
            "row_data_json": json.dumps(row, default=str),
            "rendered_message": rendered_message,
            "status": "Pending",
            "retry_count": 0,
        }).insert(ignore_permissions=True)


def _update_recipient_messages(campaign_name: str, message_template: str):
    recipients = frappe.get_all(
        "SMS Recipient",
        filters={"campaign": campaign_name},
        fields=["name", "row_data_json"],
        order_by="row_index asc",
    )

    composer = MessageComposer.from_settings()
    for row in recipients:
        row_data = json.loads(row.row_data_json or "{}")
        rendered_message = composer.compose(message_template, row_data)

        frappe.db.set_value(
            "SMS Recipient",
            row.name,
            {
                "rendered_message": rendered_message,
            },
            update_modified=False,
        )


def _build_preview(rows, template, limit=5):
    composer = MessageComposer.from_settings()
    preview = []
    for row in rows[:limit]:
        preview.append({
            "data": row,
            "message": composer.compose(template, row),
        })
    return preview


def _validate_template_variables(message_template: str, columns: list[str]):
    variables = extract_variables(message_template or "")
    missing = [var for var in variables if var not in columns]
    if missing:
        frappe.throw(
            _("These variables are missing in the uploaded file: {0}").format(", ".join(missing))
        )


def cstr(value):
    return "" if value is None else str(value)