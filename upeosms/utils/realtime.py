import frappe

def publish_campaign_progress(campaign_name: str, payload: dict):
    frappe.publish_realtime(
        event="upeosms_campaign_progress",
        message={"campaign": campaign_name, **payload},
    )