export function toCsv(rows) {
  const columns = [
    "title",
    "normalizedTitle",
    "type",
    "path",
    "shareLink",
    "linkTarget",
    "sourceShareUrl",
    "fid",
    "parentFid",
    "fileType",
    "size",
    "updatedAt",
  ];

  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}
