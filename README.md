# UPEOSMS

> **Upeosoft SMS** — Personalized bulk SMS messaging for Frappe

UPEOSMS is a [Frappe](https://frappeframework.com) app that lets you send personalized bulk SMS messages by uploading a contact list, writing a single template, and letting the app do the rest — per-recipient personalization, background sending, real-time progress, and full delivery tracking.

---

## Table of Contents

- [Features](#features)
- [Developer Guide](#developer-guide)
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [SMS Gateway Configuration](#sms-gateway-configuration)
  - [Project Structure](#project-structure)
  - [Key DocTypes](#key-doctypes)
  - [Sending Flow](#sending-flow)
  - [Troubleshooting](#troubleshooting)
- [User Guide](#user-guide)
  - [What the App Is For](#what-the-app-is-for)
  - [Step-by-Step Usage](#step-by-step-usage)
  - [Campaign & Recipient Statuses](#campaign--recipient-statuses)
  - [File Format Guidelines](#file-format-guidelines)
  - [Common Use Cases](#common-use-cases)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- 📁 **Upload contacts** from CSV or Excel files
- 🔀 **Dynamic variables** — use any file column as `{name}`, `{balance}`, `{due_date}`, etc.
- ✏️ **Template-based messaging** — write once, personalize for every recipient
- 👁️ **Message preview** — see exactly how messages will look before sending
- ⚙️ **Background queue** — sending runs via Redis workers, non-blocking
- 📊 **Real-time progress** — track sent, failed, and queued counts live
- 📋 **Delivery audit log** — review per-recipient status after every campaign

---

## Developer Guide

### Requirements

- A working [Frappe Bench](https://github.com/frappe/bench) setup
- A Frappe site
- Redis and background workers running
- An SMS gateway function exposed as:

```python
send_sms(mobile, message)
```

---

### Installation

**1. Get the app**

```bash
cd ~/frappe-bench
bench get-app $URL_OF_THIS_REPO --branch develop
```

**2. Create a site**

```bash
bench new-site local.upeosms
```

**3. Install the app**

```bash
bench --site local.upeosms install-app upeosms
```

**4. Run migrations**

```bash
bench --site local.upeosms migrate
bench --site local.upeosms clear-cache
```

**5. Enable the scheduler**

```bash
bench --site local.upeosms enable-scheduler
```

**6. Start bench**

```bash
bench start
```

> **Production:** Make sure Supervisor or your process manager is running all workers. Without active workers, messages will remain queued and never send.

---

### SMS Gateway Configuration

If your SMS sender reads credentials from `site_config.json`, set them using:

```bash
bench --site local.upeosms set-config textsms_api_key "YOUR_API_KEY"
bench --site local.upeosms set-config textsms_partner_id "YOUR_PARTNER_ID"
bench --site local.upeosms set-config textsms_sender_id "YOUR_SENDER_ID"
bench --site local.upeosms set-config textsms_endpoint_url "https://sms.textsms.co.ke/api/services/sendsms/"
bench --site local.upeosms set-config textsms_timeout 15
bench --site local.upeosms set-config textsms_payload_mode "form"
```

---

### Project Structure

```
upeosms/
├── api/
│   ├── sms.py          # SMS sending logic
│   └── page.py         # Page API methods
├── utils/
│   ├── file_parser.py  # CSV/Excel parsing
│   ├── template.py     # Variable substitution
│   └── realtime.py     # Live progress updates
└── tasks.py            # Background job definitions
```

---

### Key DocTypes

| DocType | Purpose |
|---------|---------|
| SMS Campaign | Stores campaign metadata and status |
| SMS Recipient | One record per uploaded contact |
| SMS Send Log | Audit trail of every send attempt |

---

### Sending Flow

```
Upload file → Parse contacts → Create recipients → Queue campaign
                                                         ↓
                                               Background worker
                                                         ↓
                                         send_sms(mobile, message)
                                                         ↓
                                          Log result → Update status
```

The page creates a campaign, parses the uploaded file, and creates recipients. The background worker then sends each SMS using `send_sms(mobile, message)`. Success is determined by `response.get("ok")` from your SMS gateway function.

To manually enqueue a campaign:

```python
enqueue_campaign_send(campaign_name)
```

---

### Troubleshooting

**Messages stuck in queue**

Make sure background workers are running (`bench start` in development, Supervisor in production).

**Page methods not found**

Verify the Python module path matches exactly what is called in JavaScript.

**General debugging commands:**

```bash
bench --site local.upeosms console
bench --site local.upeosms clear-cache
bench --site local.upeosms migrate
bench build
```

---

## User Guide

### What the App Is For

Use UPEOSMS when you want to send one message template to many people, while personalizing parts of the message using values from your uploaded file.

**Example template:**

```
Hi {name}, your current balance is KES {balance}.
```

If your file contains `name` and `balance` columns, each person receives their own customized SMS automatically.

---

### Step-by-Step Usage

**1. Open the Bulk SMS Console**

Navigate to the app page in Desk:

```
/app/bulk-sms-console
```

**2. Name your campaign**

Enter a meaningful campaign name, for example:

- `April Balance Reminder`
- `Rent Follow-up — June`
- `SACCO Monthly Contribution Notice`

**3. Upload your contact file**

Upload a CSV or Excel file. The file **must** include a `mobile` column. Additional columns become available as template variables.

Example file:

```
mobile,name,balance
0712345678,John,1500
0723456789,Jane,850
```

**4. Write your message template**

Use `{column_name}` syntax to reference any column from your uploaded file:

```
Hi {name}, your balance is KES {balance}. Please settle your account by the 30th.
```

**5. Insert variables**

After the file is parsed, detected column names are shown as clickable buttons. Click any variable such as `{name}` or `{balance}` to insert it into your message at the cursor position.

**6. Preview messages**

Generate a preview to see how the first few messages will look after variable substitution:

```
Hi John, your balance is KES 1500. Please settle your account by the 30th.
Hi Jane, your balance is KES 850. Please settle your account by the 30th.
```

**7. Start sending**

Click **Start Sending**. The app will:

1. Queue the campaign
2. Send each message in the background
3. Update progress in real time

**8. Monitor progress**

The dashboard shows live counts for:

- Total recipients
- Queued
- Sent
- Failed
- Percentage complete

**9. Review results**

After sending, open the campaign to review per-recipient delivery results.

**10. Fix failures**

If some recipients fail:

- Check their mobile numbers are valid
- Confirm SMS gateway credentials are correct
- Verify workers are active
- Retry after correcting any issues

---

### Campaign & Recipient Statuses

**Campaign statuses:**

| Status | Meaning |
|--------|---------|
| Draft | Created but not yet queued |
| Ready | File parsed, recipients loaded |
| Queued | Submitted to background worker |
| Sending | Worker is actively sending |
| Completed | All messages processed successfully |
| Completed with Errors | Some messages failed |
| Failed | Campaign could not be processed |

**Recipient statuses:**

| Status | Meaning |
|--------|---------|
| Pending | Awaiting send |
| Processing | Currently being sent |
| Sent | Delivered to gateway |
| Failed | Send attempt failed |

---

### File Format Guidelines

- Always include a `mobile` column
- Use clean, consistent column headers — `name`, `balance`, `due_date`
- Template variables must exactly match column names — `{full_name}` requires a `full_name` column in the file, not `name`
- Avoid blank or malformed rows
- Supported formats: `.csv`, `.xlsx`

**Example — correct variable matching:**

If the file has:

```
full_name
```

The template must use:

```
{full_name}
```

Not `{name}` unless a `name` column also exists in the file.

---

### Common Use Cases

UPEOSMS works well for:

- Customer balance reminders
- Rent and invoice follow-ups
- School fee notices
- SACCO contribution alerts
- Event notifications
- General customer follow-ups

---

## License

MIT
