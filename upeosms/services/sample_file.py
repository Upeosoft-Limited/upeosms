from frappe.utils.xlsxutils import make_xlsx


class SampleRecipientFile:
	"""The example upload file offered on the SMS console."""

	FILENAME = "sms_recipients_sample.xlsx"
	HEADER = ("mobile", "name", "amount")
	ROWS = (
		("0712345678", "Jane Wanjiku", "1500"),
		("0798765432", "John Otieno", "2000"),
		("254711222333", "Mary Achieng", "500"),
	)

	def as_xlsx(self) -> bytes:
		return make_xlsx([list(self.HEADER), *map(list, self.ROWS)], "Recipients").getvalue()
