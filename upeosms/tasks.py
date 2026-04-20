import frappe

from upeosms.api.sms import send_sms
from upeosms.utils.realtime import publish_campaign_progress

BATCH_SIZE = 100


def enqueue_campaign_send(campaign_name: str):
    frappe.enqueue(
        "upeosms.tasks.process_campaign",
        queue="long",
        timeout=1800,
        campaign_name=campaign_name,
        enqueue_after_commit=True,
    )


def process_campaign(campaign_name: str):
    frappe.db.set_value("SMS Campaign", campaign_name, "status", "Sending")
    frappe.db.commit()

    recipients = frappe.get_all(
        "SMS Recipient",
        filters={
            "campaign": campaign_name,
            "status": ["in", ["Pending", "Failed"]],
        },
        fields=["name"],
        order_by="row_index asc",
    )

    total = len(recipients)

    if not total:
        frappe.db.set_value(
            "SMS Campaign",
            campaign_name,
            {
                "status": "Failed",
                "completed_on": frappe.utils.now(),
            },
        )
        publish_campaign_progress(
            campaign_name,
            {
                "status": "Failed",
                "total": 0,
                "sent": 0,
                "failed": 0,
                "queued": 0,
                "processing": 0,
                "progress_percent": 0,
            },
        )
        frappe.db.commit()
        return

    update_campaign_counts(campaign_name)

    for i in range(0, total, BATCH_SIZE):
        batch = recipients[i : i + BATCH_SIZE]

        for item in batch:
            _process_recipient(campaign_name, item["name"])

        frappe.db.commit()
        update_campaign_counts(campaign_name)

    finalize_campaign(campaign_name)


def _process_recipient(campaign_name: str, recipient_name: str):
    recipient = frappe.get_doc("SMS Recipient", recipient_name)

    if recipient.status == "Sent":
        return

    try:
        recipient.db_set("status", "Processing")
        recipient.reload()

        mobile = (recipient.mobile or "").strip()
        message = recipient.rendered_message or ""

        if not mobile:
            _mark_recipient_failed(
                recipient=recipient,
                campaign_name=campaign_name,
                error_message="Missing mobile number",
                response=None,
            )
            return

        if not message.strip():
            _mark_recipient_failed(
                recipient=recipient,
                campaign_name=campaign_name,
                error_message="Empty rendered message",
                response=None,
            )
            return

        response = send_sms(mobile, message)

        if not response or not response.get("ok"):
            error_message = (
                (response or {}).get("error")
                or (response or {}).get("status")
                or "Send failed"
            )

            _mark_recipient_failed(
                recipient=recipient,
                campaign_name=campaign_name,
                error_message=error_message,
                response=response,
            )
            return

        recipient.db_set(
            {
                "status": "Sent",
                "provider_response": frappe.as_json(response),
                "sent_on": frappe.utils.now(),
                "error_message": None,
            }
        )

        create_log(
            campaign=campaign_name,
            recipient=recipient.name,
            mobile=recipient.mobile,
            message=recipient.rendered_message,
            status="Sent",
            response=response,
        )

    except Exception:
        error = frappe.get_traceback()[-1000:]

        recipient.db_set(
            {
                "status": "Failed",
                "provider_response": None,
                "error_message": error,
                "retry_count": (recipient.retry_count or 0) + 1,
            }
        )

        create_log(
            campaign=campaign_name,
            recipient=recipient.name,
            mobile=recipient.mobile,
            message=recipient.rendered_message,
            status="Failed",
            error=error,
        )


def _mark_recipient_failed(recipient, campaign_name: str, error_message: str, response=None):
    recipient.db_set(
        {
            "status": "Failed",
            "provider_response": frappe.as_json(response) if response else None,
            "error_message": (error_message or "Send failed")[:1000],
            "retry_count": (recipient.retry_count or 0) + 1,
        }
    )

    create_log(
        campaign=campaign_name,
        recipient=recipient.name,
        mobile=recipient.mobile,
        message=recipient.rendered_message,
        status="Failed",
        response=response,
        error=(error_message or "Send failed")[:1000],
    )


def update_campaign_counts(campaign_name: str):
    total = frappe.db.count("SMS Recipient", {"campaign": campaign_name})
    sent = frappe.db.count("SMS Recipient", {"campaign": campaign_name, "status": "Sent"})
    failed = frappe.db.count("SMS Recipient", {"campaign": campaign_name, "status": "Failed"})
    processing = frappe.db.count(
        "SMS Recipient", {"campaign": campaign_name, "status": "Processing"}
    )
    queued = frappe.db.count(
        "SMS Recipient",
        {
            "campaign": campaign_name,
            "status": ["in", ["Pending", "Queued", "Processing"]],
        },
    )

    progress = 0
    if total:
        progress = round(((sent + failed) / total) * 100, 2)

    frappe.db.set_value(
        "SMS Campaign",
        campaign_name,
        {
            "queued_count": queued,
            "sent_count": sent,
            "failed_count": failed,
            "progress_percent": progress,
        },
    )

    current_status = frappe.db.get_value("SMS Campaign", campaign_name, "status")

    publish_campaign_progress(
        campaign_name,
        {
            "status": current_status,
            "total": total,
            "sent": sent,
            "failed": failed,
            "queued": queued,
            "processing": processing,
            "progress_percent": progress,
        },
    )


def finalize_campaign(campaign_name: str):
    update_campaign_counts(campaign_name)

    campaign = frappe.get_doc("SMS Campaign", campaign_name)
    campaign.reload()

    final_status = "Completed"
    if campaign.failed_count and campaign.sent_count:
        final_status = "Completed with Errors"
    elif campaign.failed_count and not campaign.sent_count:
        final_status = "Failed"

    campaign.db_set(
        {
            "status": final_status,
            "completed_on": frappe.utils.now(),
        }
    )

    campaign.reload()

    publish_campaign_progress(
        campaign_name,
        {
            "status": final_status,
            "total": campaign.total_recipients,
            "sent": campaign.sent_count,
            "failed": campaign.failed_count,
            "queued": campaign.queued_count,
            "processing": 0,
            "progress_percent": campaign.progress_percent,
        },
    )


def create_log(campaign, recipient, mobile, message, status, response=None, error=None):
    frappe.get_doc(
        {
            "doctype": "SMS Send Log",
            "campaign": campaign,
            "recipient": recipient,
            "mobile": mobile,
            "message": message,
            "status": status,
            "response": frappe.as_json(response) if response else None,
            "error_message": error,
            "sent_on": frappe.utils.now(),
        }
    ).insert(ignore_permissions=True)