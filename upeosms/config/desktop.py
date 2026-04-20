from frappe import _

def get_data():
    return [
        {
            "module_name": "UpeoSMS",
            "type": "module",
            "label": _("UpeoSMS"),
            "color": "blue",
            "icon": "octicon octicon-comment-discussion",
            "description": _("Bulk SMS campaigns"),
        }
    ]